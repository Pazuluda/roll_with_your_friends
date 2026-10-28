// Synchronisation logic, kept free of browser-extension APIs so it can be tested
// with a fake player (see test/sync.sim.ts).
//
// The idea: we keep our own picture of the room (state + position + when we learnt it).
// A local player event is only sent to the room when the player really differs from
// that picture. Changes we apply ourselves after a remote update therefore never get
// echoed back, which is what used to cause the ping-pong after skipping an opening.

import { States } from "./types";

export interface VideoLike {
  paused: boolean;
  currentTime: number;
  readyState: number;
  seeking: boolean;
  duration: number;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface Clock {
  now(): number; // milliseconds
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random?(): number;
}

export interface RemoteState {
  // "join": we just entered (or re-entered) the room. "update": the room changed.
  kind: "join" | "update";
  // true when the join follows a reconnection while we were already in the room
  rejoin?: boolean;
  state: States;
  progress: number;
  userCount: number;
  // socket id of the friend who caused the update (absent for "join")
  senderId?: string;
}

// Controls the site's own player (Crunchyroll's Bitmovin player). Moving the
// <video> element directly bypasses it: it then stops loading and freezes.
// Each method returns false when it could not act (we then use the <video>).
export interface PlayerDriver {
  // false: not handled. A number: handled, and how long the driver needs (ms);
  // the position may then only be approximate (e.g. jumps of 10 s)
  seek(time: number): number | false;
  play(): boolean;
  pause(): boolean;
  // click the site's own play button (to restart a frozen player)
  clickPlay?(): boolean;
}

export interface SyncCallbacks {
  send(state: States, progress: number): void;
  onAutoplayBlocked(blocked: boolean): void;
  log?(...args: unknown[]): void;
}

export const SYNC = {
  // A local change closer than this to the room position is not broadcast (seconds)
  LOCAL_TOLERANCE: 1.0,
  // We only seek to follow a playing room when further away than this (seconds)
  REMOTE_TOLERANCE: 1.0,
  // When the room pauses, we align precisely when further away than this (seconds)
  PAUSE_SNAP: 0.3,
  // Background correction when someone falls behind during playback (seconds)
  DRIFT_TOLERANCE: 0.8,
  // Each correction is a small jump (Crunchyroll even pauses for it): if two
  // did not fix the gap, stop until the room changes instead of looping
  DRIFT_MAX_FIXES: 2,
  // Small gaps while playing are closed by playing slightly faster or slower
  // instead of jumping (a jump makes Crunchyroll's player reload and stall)
  RATE_MAX_GAP: 5,
  RATE_DEADBAND: 0.25,
  RATE_GAIN: 0.25,
  RATE_MIN: 0.7,
  RATE_MAX: 1.5,
  // Ahead of the room by more than this: wait (short pause) instead of slowing down
  HOLD_AHEAD: 1.5,
  DRIFT_CHECK_MS: 2000,
  // No drift correction right after any sync activity, the player needs time to settle
  DRIFT_GRACE_MS: 5000,
  // Groups bursts of player events (seek + play, scrubbing...) into one decision
  DEBOUNCE_MS: 200,
  // Crunchyroll's player pauses itself while it loads a jump made from outside
  // (by us, for the room) and resumes afterwards. A pause that starts during a
  // jump, or this soon after it, belongs to the player, not to the viewer.
  SEEK_SETTLE_MS: 1500,
  RECHECK_MS: 400,
  // Crunchyroll's player sometimes stays frozen after a jump made from outside
  // its controls: "playing", but the image no longer moves. A pause/play (what
  // spamming the space bar did) or a new jump to the same place unblocks it.
  STALL_MS: 3000,
  STALL_RETRY_MS: 3000,
  STALL_CHECK_MS: 1000,
  STALL_MAX_ATTEMPTS: 3,
  // A gap bigger than this is not drift: it is a jump that was not announced
  // (or a player that went somewhere by itself). It is told to the room
  // instead of being silently undone.
  DRIFT_MAX: 8,
  // No drift correction this soon after the viewer touched the player
  LOCAL_EVENT_GRACE_MS: 4000,
  // On arrival, Crunchyroll's player first goes to the viewer's own resume
  // point. Moving it during that start-up freezes it: wait until it has been
  // ready and still for this long before applying the room position.
  JOIN_SETTLE_MS: 1500,
  // A position change only counts as the viewer's jump for this long
  VIEWER_SEEK_MS: 6000,
  // Right after joining, changes made by the player itself (resume position,
  // autoplay) are corrected instead of being broadcast
  ENFORCE_MS: 5000,
  // A jump that needed at least this long to load may have left us behind the
  // others: we then tell the room our real position so that everybody waits
  LOADING_DELAY_MS: 750,
  // Delay before telling a newcomer the real room state (spread between members)
  REASSERT_MS: [150, 600] as [number, number],
  // After our own reconnection we let the others speak first
  REJOIN_REASSERT_MS: [1200, 1800] as [number, number],
  // Two friends acting at the same moment: their messages cross. An update that
  // contradicts ours and arrives this soon after it may be older than ours on the
  // server, so the room could be split; we then confirm the state we now follow.
  CROSS_WINDOW_MS: 1000,
  CONFIRM_MS: [300, 1200] as [number, number],
  // A join notification repeats the room's last stored position exactly
  STALE_EPSILON: 0.05,
};

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

interface RoomPicture {
  state: States;
  progress: number; // position as received or sent
  at: number; // clock time when we got it
}

export interface Snapshot {
  state: States;
  progress: number;
}

export class SyncController {
  private video?: VideoLike;
  private listeners: Array<[string, () => void]> = [];
  private inRoom = false;
  private room?: RoomPicture;
  private userCount = 0;
  private knownSenders = new Set<string>();
  private remoteSeq = 0;
  private awaitingInitialSync = false;
  private reassertWhenReady = false;
  private enforceUntil = -Infinity;
  private autoplayBlocked = false;
  private lastActivityAt = -Infinity;
  private lastDriftFixAt = -Infinity;
  private driftFixes = 0;
  private lastSent?: RoomPicture;
  private lastRemoteAt = -Infinity;
  private seekStartedAt?: number;
  private seekBusy = false;
  private seekSettleUntil = -Infinity;
  private pauseDuringSeek = false;
  private stallPosition = -1;
  private stallSince = -Infinity;
  private lastUnstickAt = -Infinity;
  private unstickAttempts = 0;
  private stallTimer?: unknown;
  private ownSeek?: { target: number; until: number; approximate: boolean };
  private seekByViewer = false;
  private viewerJumpAnnounced = false;
  private lastViewerSeekAt = -Infinity;
  private joinTimer?: unknown;
  private lastLocalEventAt = -Infinity;
  private ignoreLocalUntil = -Infinity;
  private debounceTimer?: unknown;
  private driftTimer?: unknown;

  private driver?: PlayerDriver;
  private rateAdjusted = false;
  private lastPauseEventAt = -Infinity;

  constructor(private clock: Clock, private cb: SyncCallbacks) {}

  setDriver(driver: PlayerDriver | undefined): void {
    this.driver = driver;
  }

  // ---------------------------------------------------------------- player

  attach(video: VideoLike): void {
    if (this.video === video) return;
    this.detach();
    this.video = video;

    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.listeners.push([type, fn]);
    };
    on("play", () => {
      this.lastLocalEventAt = this.clock.now();
      this.pauseDuringSeek = false;
      this.onLocalChange("play");
    });
    on("pause", () => {
      this.lastPauseEventAt = this.clock.now();
      this.lastLocalEventAt = this.clock.now();
      this.pauseDuringSeek = this.seekInProgress();
      this.onLocalChange("pause");
    });
    on("seeking", () => {
      const now = this.clock.now();
      this.lastLocalEventAt = now;
      // Was this jump made by us (for the room) or by the viewer?
      const own = this.ownSeek;
      this.seekByViewer = !(
        own &&
        now < own.until &&
        (own.approximate || Math.abs(video.currentTime - own.target) < 1)
      );
      if (this.seekByViewer) this.lastViewerSeekAt = now;
      // Crunchyroll pauses right before jumping: that pause belongs to the jump
      if (video.paused && now - this.lastPauseEventAt < 600) this.pauseDuringSeek = true;
      this.viewerJumpAnnounced = false;
      this.seekBusy = true;
      this.seekStartedAt = this.seekStartedAt ?? now;
      this.onLocalChange("seeking");
    });
    on("seeked", () => {
      this.seekBusy = false;
      this.seekSettleUntil = this.clock.now() + SYNC.SEEK_SETTLE_MS;
      this.onPlaybackResumed();
    });
    on("playing", () => this.onPlaybackResumed());
    for (const type of ["loadedmetadata", "canplay", "canplaythrough", "durationchange", "seeked", "playing"]) {
      on(type, () => this.onPlayerMaybeReady());
    }

    // A new player while in a room (Crunchyroll rebuilt it): sync it like on arrival
    if (this.inRoom && this.room) this.awaitingInitialSync = true;
    this.onPlayerMaybeReady();
  }

  detach(): void {
    if (this.video) {
      for (const [type, fn] of this.listeners) {
        this.video.removeEventListener(type, fn);
      }
    }
    this.listeners = [];
    this.video = undefined;
  }

  snapshot(): Snapshot {
    const v = this.video;
    if (!v) return { state: States.PAUSED, progress: 0 };
    return {
      state: v.paused ? States.PAUSED : States.PLAYING,
      progress: v.currentTime,
    };
  }

  // ---------------------------------------------------------------- room

  handleRemote(msg: RemoteState): void {
    this.remoteSeq++;
    const previousCount = this.userCount;
    this.userCount = msg.userCount;
    this.log("Remote", msg);

    if (msg.kind === "join") {
      this.enterRoom();

      if (msg.userCount <= 1) {
        // Alone in the room (we created it, or everybody else left):
        // our player is the reference, the room should follow it.
        this.setRoom(msg.state, msg.progress);
        this.awaitingInitialSync = false;
        if (this.canBroadcast()) this.broadcast();
        else this.reassertWhenReady = true;
        return;
      }

      if (msg.rejoin && (this.weSpokeLast() || this.looksLikeJoinReset(msg))) {
        // Our connection came back. The server answered with the room reset to
        // "paused" at its last stored position, and our own last message (sent
        // while reconnecting) reaches it only now. Keep our state: the others
        // will correct the room, otherwise we will.
        this.scheduleReassert(SYNC.REJOIN_REASSERT_MS);
        return;
      }

      this.setRoom(msg.state, msg.progress);
      this.awaitingInitialSync = true;
      this.onPlayerMaybeReady();
      return;
    }

    if (!this.inRoom) return;

    // The server announces a newcomer with an update sent "by" the newcomer's
    // fresh connection: an id that never sent anything before.
    const firstFromSender = msg.senderId === undefined || !this.knownSenders.has(msg.senderId);
    if (msg.senderId !== undefined) this.knownSenders.add(msg.senderId);

    if (
      msg.state === States.PAUSED &&
      this.room &&
      (msg.userCount > previousCount || (firstFromSender && this.looksLikeJoinReset(msg)))
    ) {
      // Somebody joined: the server forces "paused" and repeats the last stored
      // position, which can be minutes old. Don't obey it, tell the room the truth.
      this.scheduleReassert(SYNC.REASSERT_MS, true);
      return;
    }

    const crossed = this.crossesOurLastMessage(msg);
    this.lastRemoteAt = this.clock.now();
    this.setRoom(msg.state, msg.progress);
    this.applyRoom();
    if (crossed) {
      this.log("Messages crossed, confirming the room state");
      this.scheduleReassert(SYNC.CONFIRM_MS, true);
    }
  }

  leaveRoom(): void {
    this.setRate(1);
    this.inRoom = false;
    this.room = undefined;
    this.lastSent = undefined;
    this.lastRemoteAt = -Infinity;
    this.knownSenders.clear();
    this.userCount = 0;
    this.awaitingInitialSync = false;
    this.reassertWhenReady = false;
    this.seekStartedAt = undefined;
    this.seekBusy = false;
    this.pauseDuringSeek = false;
    this.enforceUntil = -Infinity;
    this.setAutoplayBlocked(false);
    if (this.debounceTimer !== undefined) this.clock.clearTimeout(this.debounceTimer);
    if (this.driftTimer !== undefined) this.clock.clearTimeout(this.driftTimer);
    if (this.stallTimer !== undefined) this.clock.clearTimeout(this.stallTimer);
    if (this.joinTimer !== undefined) this.clock.clearTimeout(this.joinTimer);
    this.joinTimer = undefined;
    this.lastViewerSeekAt = -Infinity;
    this.debounceTimer = undefined;
    this.driftTimer = undefined;
    this.stallTimer = undefined;
    this.stallPosition = -1;
    this.unstickAttempts = 0;
  }

  // Called from a click on the "join playback" button (user gesture, so the
  // browser accepts to start the video).
  resumeFromUserGesture(): void {
    this.setAutoplayBlocked(false);
    this.enforceUntil = Math.max(this.enforceUntil, this.clock.now() + SYNC.ENFORCE_MS);
    this.applyRoom();
  }

  // ---------------------------------------------------------------- internals

  private enterRoom(): void {
    if (this.inRoom) return;
    this.inRoom = true;
    this.scheduleDriftCheck();
    this.scheduleStallCheck();
  }

  private scheduleStallCheck(): void {
    this.stallTimer = this.clock.setTimeout(() => {
      this.stallTimer = undefined;
      if (!this.inRoom) return;
      this.checkStall();
      this.scheduleStallCheck();
    }, SYNC.STALL_CHECK_MS);
  }

  private isAdvancing(): boolean {
    return this.clock.now() - this.stallSince < 2000;
  }

  private setRate(rate: number): void {
    const v = this.video;
    if (!v) return;
    if (rate === 1) {
      if (!this.rateAdjusted) return;
      this.rateAdjusted = false;
    } else {
      this.rateAdjusted = true;
    }
    try {
      if (Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
    } catch {
      // ignore
    }
  }

  private adjustRate(): void {
    const v = this.video;
    const now = this.clock.now();
    const usable =
      !!v &&
      !!this.room &&
      this.room.state === States.PLAYING &&
      !v.paused &&
      !v.seeking &&
      v.readyState >= HAVE_FUTURE_DATA &&
      !this.awaitingInitialSync &&
      !this.autoplayBlocked &&
      now >= this.ignoreLocalUntil &&
      !this.seekInProgress();
    if (!usable) {
      this.setRate(1);
      return;
    }
    const behind = this.expected() - v!.currentTime;
    if (-behind > SYNC.HOLD_AHEAD && -behind <= SYNC.RATE_MAX_GAP) {
      // Ahead: wait for the others with a short pause, without telling the room
      const waitMs = -behind * 1000;
      this.setRate(1);
      this.log("Ahead of the room, waiting", { seconds: Math.round(-behind * 10) / 10 });
      this.ignoreLocalUntil = now + waitMs + 1500;
      this.pauseVideo();
      this.clock.setTimeout(() => {
        if (this.inRoom && this.video === v && v!.paused && this.room?.state === States.PLAYING) this.tryPlay();
      }, waitMs);
      return;
    }
    if (Math.abs(behind) < SYNC.RATE_DEADBAND || Math.abs(behind) > SYNC.RATE_MAX_GAP) {
      this.setRate(1);
      return;
    }
    const rate = Math.min(SYNC.RATE_MAX, Math.max(SYNC.RATE_MIN, 1 + behind * SYNC.RATE_GAIN));
    this.setRate(Math.round(rate * 100) / 100);
  }

  private checkStall(): void {
    this.adjustRate();
    const v = this.video;
    const now = this.clock.now();
    const playingRoom = !!this.room && this.room.state === States.PLAYING;
    if (!v || !playingRoom || v.paused || this.autoplayBlocked || !this.playerReady()) {
      this.stallPosition = -1;
      this.unstickAttempts = 0;
      return;
    }
    const duration = v.duration;
    if (isFinite(duration) && duration > 0 && v.currentTime >= duration - 1) return; // end of episode

    if (Math.abs(v.currentTime - this.stallPosition) > 0.05) {
      // The video moves: all good
      this.stallPosition = v.currentTime;
      this.stallSince = now;
      this.unstickAttempts = 0;
      return;
    }
    if (now - this.stallSince < SYNC.STALL_MS) return;
    if (now - this.lastUnstickAt < SYNC.STALL_RETRY_MS) return;

    if (this.unstickAttempts >= SYNC.STALL_MAX_ATTEMPTS) return;
    this.lastUnstickAt = now;
    this.unstickAttempts++;
    // What the player does now is our doing: nothing is sent to the room
    this.ignoreLocalUntil = now + SYNC.SEEK_SETTLE_MS;
    // the pause below is the player's business: if it stays paused, restart it
    this.seekSettleUntil = now + SYNC.SEEK_SETTLE_MS;
    this.seekByViewer = false;
    if (this.unstickAttempts % 2 === 1) {
      this.log("Player frozen, pause/play to unblock it", { at: v.currentTime });
      this.pauseVideo();
      this.clock.setTimeout(() => {
        if (this.inRoom && this.video === v && v.paused) this.tryPlay();
      }, 300);
    } else {
      this.log("Player frozen, seeking again to unblock it", { at: v.currentTime });
      this.seekTo(Math.max(0, this.expected()));
    }
  }

  private setRoom(state: States, progress: number): void {
    this.room = { state, progress, at: this.clock.now() };
    this.driftFixes = 0;
    this.lastActivityAt = this.clock.now();
  }

  private expected(): number {
    const room = this.room!;
    let position = room.progress;
    if (room.state === States.PLAYING) {
      position += (this.clock.now() - room.at) / 1000;
    }
    const duration = this.video?.duration;
    if (duration !== undefined && isFinite(duration) && duration > 0) {
      position = Math.min(position, duration);
    }
    return Math.max(0, position);
  }

  private playerReady(): boolean {
    return !!this.video && this.video.readyState >= HAVE_METADATA;
  }

  private canBroadcast(): boolean {
    return (
      this.inRoom &&
      this.playerReady() &&
      !this.awaitingInitialSync &&
      !this.autoplayBlocked
    );
  }

  private diverges(snap: Snapshot, tolerance: number): boolean {
    if (!this.room) return true;
    return (
      snap.state !== this.room.state ||
      Math.abs(snap.progress - this.expected()) > tolerance
    );
  }

  private looksLikeJoinReset(msg: RemoteState): boolean {
    return (
      msg.state === States.PAUSED &&
      !!this.room &&
      this.room.state === States.PLAYING &&
      Math.abs(msg.progress - this.room.progress) < SYNC.STALE_EPSILON
    );
  }

  private weSpokeLast(): boolean {
    return !!this.lastSent && this.lastSent.at >= this.lastRemoteAt;
  }

  private crossesOurLastMessage(msg: RemoteState): boolean {
    const sent = this.lastSent;
    if (!sent || this.clock.now() - sent.at > SYNC.CROSS_WINDOW_MS) return false;
    if (msg.state !== sent.state) return true;
    const sentNow =
      sent.progress + (sent.state === States.PLAYING ? (this.clock.now() - sent.at) / 1000 : 0);
    return Math.abs(msg.progress - sentNow) > SYNC.LOCAL_TOLERANCE;
  }

  private broadcast(snap: Snapshot = this.snapshot()): void {
    this.log("Broadcast", snap);
    this.cb.send(snap.state, snap.progress);
    this.setRoom(snap.state, snap.progress);
    this.lastSent = { ...this.room! };
  }

  // followRoom: repeat the room state we follow (not where our player happens
  // to be, which may still be loading)
  private scheduleReassert([min, max]: [number, number], followRoom = false): void {
    const seq = this.remoteSeq;
    const random = this.clock.random ? this.clock.random() : Math.random();
    this.clock.setTimeout(() => {
      // Someone else already told the room, nothing to do
      if (this.remoteSeq !== seq) return;
      if (!this.canBroadcast()) return;
      if (followRoom && this.room) {
        this.broadcast({ state: this.room.state, progress: this.expected() });
      } else {
        this.broadcast();
      }
    }, min + random * (max - min));
  }

  private onPlayerMaybeReady(): void {
    if (!this.inRoom || !this.playerReady()) return;

    if (this.reassertWhenReady) {
      this.reassertWhenReady = false;
      this.awaitingInitialSync = false;
      this.broadcast();
      return;
    }

    if (this.awaitingInitialSync && this.room) this.scheduleJoinSync();
  }

  private playerSettled(): boolean {
    const v = this.video;
    return !!v && v.readyState >= HAVE_FUTURE_DATA && !v.seeking;
  }

  private scheduleJoinSync(): void {
    if (this.joinTimer !== undefined) this.clock.clearTimeout(this.joinTimer);
    this.joinTimer = this.clock.setTimeout(() => {
      this.joinTimer = undefined;
      if (!this.inRoom || !this.awaitingInitialSync || !this.room) return;
      if (!this.playerSettled()) return; // a later player event will try again
      this.awaitingInitialSync = false;
      this.enforceUntil = this.clock.now() + SYNC.ENFORCE_MS;
      this.log("Player ready, joining the room position");
      this.applyRoom();
    }, SYNC.JOIN_SETTLE_MS);
  }

  private onLocalChange(kind: "play" | "pause" | "seeking"): void {
    if (!this.inRoom || !this.video) return;

    if (kind === "play" && this.autoplayBlocked) {
      // The user started the video by hand: playback is allowed again.
      // Bring it to the room position rather than broadcasting a stale one.
      this.setAutoplayBlocked(false);
      this.enforceUntil = Math.max(this.enforceUntil, this.clock.now() + 1500);
    }

    if (this.debounceTimer !== undefined) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = undefined;
      this.evaluateLocalChange();
    }, SYNC.DEBOUNCE_MS);
  }

  private evaluateLocalChange(): void {
    const v = this.video;
    if (!this.inRoom || !v || !this.room) return;
    if (!this.playerReady() || this.awaitingInitialSync || this.autoplayBlocked) return;

    if (this.clock.now() < this.ignoreLocalUntil) {
      // our own unblocking pause/play: look again once it is over
      this.recheckLater();
      return;
    }
    const snap = this.snapshot();
    if (!this.diverges(snap, SYNC.LOCAL_TOLERANCE)) return; // matches the room: our own change or an echo

    if (this.clock.now() < this.enforceUntil) {
      // Just joined: the player moved by itself (resume point, autoplay...)
      this.log("Correcting player-initiated change", snap);
      this.applyRoom();
      return;
    }

    if (snap.state === States.PAUSED && this.room.state === States.PLAYING && this.pauseDuringSeek) {
      if (
        this.seekByViewer &&
        !this.viewerJumpAnnounced &&
        Math.abs(snap.progress - this.expected()) > SYNC.LOCAL_TOLERANCE
      ) {
        this.viewerJumpAnnounced = true;
        // The viewer jumped (e.g. "Skip intro") and the player paused itself to
        // load: tell the room about the jump, the room keeps playing
        this.broadcast({ state: States.PLAYING, progress: snap.progress });
      }
      if (this.seekInProgress()) {
        // The player paused itself to load a jump: wait for it to finish
        this.recheckLater();
        return;
      }
      // The jump is loaded but the player stayed paused: start it again
      this.pauseDuringSeek = false;
      this.log("Player paused itself during a jump, resuming");
      this.applyRoom();
      return;
    }

    if (snap.state === this.room.state) {
      // Same play/pause state, different position. Only a jump made by the
      // viewer is news for the room; anything else (a frozen or lagging
      // player) is ours to fix, never to impose on the others.
      if (this.clock.now() - this.lastViewerSeekAt > SYNC.VIEWER_SEEK_MS) return;
    }

    this.broadcast(snap);
  }

  private seekInProgress(): boolean {
    const v = this.video;
    return this.seekBusy || !!v?.seeking || this.clock.now() < this.seekSettleUntil;
  }

  private recheckLater(): void {
    if (this.debounceTimer !== undefined) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = undefined;
      this.evaluateLocalChange();
    }, SYNC.RECHECK_MS);
  }

  // A jump (ours, or one we applied for the room) finished loading.
  // Loading times differ between friends: whoever finishes last is behind.
  private onPlaybackResumed(): void {
    const v = this.video;
    if (this.seekStartedAt === undefined || !v) return;
    if (v.paused) {
      // A player that paused itself for the jump will resume: wait for "playing"
      if (!this.pauseDuringSeek) this.seekStartedAt = undefined;
      return;
    }
    if (v.seeking || v.readyState < HAVE_FUTURE_DATA) return; // still loading, wait for "playing"

    const waited = this.clock.now() - this.seekStartedAt;
    this.seekStartedAt = undefined;
    if (waited < SYNC.LOADING_DELAY_MS) return;
    if (!this.room || this.room.state !== States.PLAYING || !this.canBroadcast()) return;
    if (this.expected() - v.currentTime <= SYNC.LOCAL_TOLERANCE) return;
    if (v.readyState < HAVE_FUTURE_DATA) return;

    // Behind after loading: catch up (speed adjustment, or a jump if far)
    // rather than making everybody step back, which made them reload too
    this.applyRoom();
  }

  private applyRoom(): void {
    const v = this.video;
    if (!v || !this.room) return;
    if (!this.playerReady()) {
      this.awaitingInitialSync = true;
      return;
    }

    this.lastActivityAt = this.clock.now();
    const target = this.expected();

    if (this.room.state === States.PAUSED) {
      this.setAutoplayBlocked(false);
      if (!v.paused) this.pauseVideo();
      if (Math.abs(v.currentTime - target) > SYNC.PAUSE_SNAP) this.seekTo(target);
    } else {
      const gap = Math.abs(v.currentTime - target);
      // small gaps are closed by adjusting the speed (unless we must start playing)
      if (gap > SYNC.RATE_MAX_GAP || (gap > SYNC.REMOTE_TOLERANCE && v.paused)) this.seekTo(target);
      if (v.paused) this.tryPlay();
    }
  }

  private seekTo(target: number): void {
    const now = this.clock.now();
    const handled = this.driver ? this.driver.seek(target) : false;
    if (handled !== false) {
      // approximate jumps take a while to settle: our own for longer
      this.ownSeek = { target, until: now + handled + 5000, approximate: true };
      return;
    }
    this.ownSeek = { target, until: now + 2000, approximate: false };
    this.video!.currentTime = target;
  }

  private pauseVideo(): void {
    if (this.driver?.pause()) return;
    this.video!.pause();
  }

  private tryPlay(): void {
    if (this.driver?.play()) return;
    let result: Promise<void> | void;
    try {
      result = this.video!.play();
    } catch (error) {
      this.onPlayError(error);
      return;
    }
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((error) => this.onPlayError(error));
    }
  }

  private onPlayError(error: unknown): void {
    const name = (error as { name?: string } | undefined)?.name;
    this.log("play() refused", name);
    if (name === "NotAllowedError") {
      // Browser autoplay policy: the page needs a click before it can play sound
      if (this.room?.state === States.PLAYING && this.video?.paused) {
        this.setAutoplayBlocked(true);
      }
    }
    if (name === "AbortError" && this.driver?.clickPlay) {
      // The <video> refused to start (Crunchyroll's player is stuck):
      // press its own play button instead, like a viewer would
      this.clock.setTimeout(() => {
        const v = this.video;
        if (!this.inRoom || !v || !v.paused || this.room?.state !== States.PLAYING) return;
        this.ignoreLocalUntil = this.clock.now() + SYNC.SEEK_SETTLE_MS;
        this.log("Pressing the player's play button");
        this.driver?.clickPlay?.();
      }, 250);
    }
  }

  private setAutoplayBlocked(blocked: boolean): void {
    if (this.autoplayBlocked === blocked) return;
    this.autoplayBlocked = blocked;
    this.cb.onAutoplayBlocked(blocked);
  }

  private scheduleDriftCheck(): void {
    this.driftTimer = this.clock.setTimeout(() => {
      this.driftTimer = undefined;
      if (!this.inRoom) return;
      this.checkDrift();
      this.scheduleDriftCheck();
    }, SYNC.DRIFT_CHECK_MS);
  }

  private checkDrift(): void {
    const v = this.video;
    if (!v || !this.room || !this.playerReady()) return;
    if (this.awaitingInitialSync || this.autoplayBlocked) return;
    if (this.seekStartedAt !== undefined) return;
    if (this.room.state !== States.PLAYING || v.paused || v.seeking) return;
    if (v.readyState < HAVE_FUTURE_DATA) return;

    const now = this.clock.now();
    if (this.debounceTimer !== undefined) return; // a local change is being evaluated
    if (now - this.lastActivityAt < SYNC.DRIFT_GRACE_MS) return;
    if (now - this.lastDriftFixAt < SYNC.DRIFT_GRACE_MS) return;
    if (now - this.lastLocalEventAt < SYNC.LOCAL_EVENT_GRACE_MS) return;
    if (now < this.ignoreLocalUntil) return;

    const target = this.expected();
    const gap = Math.abs(v.currentTime - target);
    if (gap <= SYNC.RATE_MAX_GAP) return; // handled by the speed adjustment

    if (gap > SYNC.DRIFT_MAX && now - this.lastViewerSeekAt < 30000) {
      // The viewer jumped and it was not announced: announce it, if the
      // player really plays there (a frozen player must not lead the room)
      if (this.isAdvancing() && this.canBroadcast() && now >= this.enforceUntil) {
        this.log("Unannounced jump, telling the room", { at: v.currentTime, room: target });
        this.lastViewerSeekAt = -Infinity;
        this.broadcast();
      }
      return;
    }

    if (this.driftFixes >= SYNC.DRIFT_MAX_FIXES) return;
    this.driftFixes++;
    this.log("Drift correction", { from: v.currentTime, to: target });
    this.lastDriftFixAt = now;
    this.seekTo(target);
  }

  private log(...args: unknown[]): void {
    this.cb.log?.(...args);
  }
}
