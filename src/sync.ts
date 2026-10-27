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
  DRIFT_TOLERANCE: 0.6,
  DRIFT_CHECK_MS: 2000,
  // No drift correction right after any sync activity, the player needs time to settle
  DRIFT_GRACE_MS: 5000,
  // Groups bursts of player events (seek + play, scrubbing...) into one decision
  DEBOUNCE_MS: 200,
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
  private lastSent?: RoomPicture;
  private lastRemoteAt = -Infinity;
  private seekStartedAt?: number;
  private debounceTimer?: unknown;
  private driftTimer?: unknown;

  constructor(private clock: Clock, private cb: SyncCallbacks) {}

  // ---------------------------------------------------------------- player

  attach(video: VideoLike): void {
    if (this.video === video) return;
    this.detach();
    this.video = video;

    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.listeners.push([type, fn]);
    };
    on("play", () => this.onLocalChange("play"));
    on("pause", () => this.onLocalChange("pause"));
    on("seeking", () => {
      this.seekStartedAt = this.seekStartedAt ?? this.clock.now();
      this.onLocalChange("seeking");
    });
    on("seeked", () => this.onPlaybackResumed());
    on("playing", () => this.onPlaybackResumed());
    for (const type of ["loadedmetadata", "canplay", "durationchange"]) {
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
      this.scheduleReassert(SYNC.REASSERT_MS);
      return;
    }

    const crossed = this.crossesOurLastMessage(msg);
    this.lastRemoteAt = this.clock.now();
    this.setRoom(msg.state, msg.progress);
    this.applyRoom();
    if (crossed) {
      this.log("Messages crossed, confirming the room state");
      this.scheduleReassert(SYNC.CONFIRM_MS);
    }
  }

  leaveRoom(): void {
    this.inRoom = false;
    this.room = undefined;
    this.lastSent = undefined;
    this.lastRemoteAt = -Infinity;
    this.knownSenders.clear();
    this.userCount = 0;
    this.awaitingInitialSync = false;
    this.reassertWhenReady = false;
    this.seekStartedAt = undefined;
    this.enforceUntil = -Infinity;
    this.setAutoplayBlocked(false);
    if (this.debounceTimer !== undefined) this.clock.clearTimeout(this.debounceTimer);
    if (this.driftTimer !== undefined) this.clock.clearTimeout(this.driftTimer);
    this.debounceTimer = undefined;
    this.driftTimer = undefined;
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
  }

  private setRoom(state: States, progress: number): void {
    this.room = { state, progress, at: this.clock.now() };
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

  private scheduleReassert([min, max]: [number, number]): void {
    const seq = this.remoteSeq;
    const random = this.clock.random ? this.clock.random() : Math.random();
    this.clock.setTimeout(() => {
      // Someone else already told the room, nothing to do
      if (this.remoteSeq !== seq) return;
      if (!this.canBroadcast()) return;
      this.broadcast();
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

    if (this.awaitingInitialSync && this.room) {
      this.awaitingInitialSync = false;
      this.enforceUntil = this.clock.now() + SYNC.ENFORCE_MS;
      this.applyRoom();
    }
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

    const snap = this.snapshot();
    if (!this.diverges(snap, SYNC.LOCAL_TOLERANCE)) return; // matches the room: our own change or an echo

    if (this.clock.now() < this.enforceUntil) {
      // Just joined: the player moved by itself (resume point, autoplay...)
      this.log("Correcting player-initiated change", snap);
      this.applyRoom();
      return;
    }

    this.broadcast(snap);
  }

  // A jump (ours, or one we applied for the room) finished loading.
  // Loading times differ between friends: whoever finishes last is behind.
  private onPlaybackResumed(): void {
    const v = this.video;
    if (this.seekStartedAt === undefined || !v) return;
    if (v.paused) {
      this.seekStartedAt = undefined;
      return;
    }
    if (v.seeking || v.readyState < HAVE_FUTURE_DATA) return; // still loading, wait for "playing"

    const waited = this.clock.now() - this.seekStartedAt;
    this.seekStartedAt = undefined;
    if (waited < SYNC.LOADING_DELAY_MS) return;
    if (!this.room || this.room.state !== States.PLAYING || !this.canBroadcast()) return;
    if (this.expected() - v.currentTime <= SYNC.LOCAL_TOLERANCE) return;

    if (this.clock.now() < this.enforceUntil) {
      // We just arrived: catch up with the others rather than making them wait
      this.applyRoom();
    } else {
      // The room waits for us: friends that are ahead step back a little
      this.log("Behind after loading, telling the room");
      this.broadcast();
    }
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
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > SYNC.PAUSE_SNAP) v.currentTime = target;
    } else {
      if (Math.abs(v.currentTime - target) > SYNC.REMOTE_TOLERANCE) v.currentTime = target;
      if (v.paused) this.tryPlay();
    }
  }

  private tryPlay(): void {
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
    // AbortError: play() interrupted by pause() or a new source, nothing to do
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
    if (now - this.lastActivityAt < SYNC.DRIFT_GRACE_MS) return;
    if (now - this.lastDriftFixAt < SYNC.DRIFT_GRACE_MS) return;

    const target = this.expected();
    if (Math.abs(v.currentTime - target) <= SYNC.DRIFT_TOLERANCE) return;

    this.log("Drift correction", { from: v.currentTime, to: target });
    this.lastDriftFixAt = now;
    v.currentTime = target;
  }

  private log(...args: unknown[]): void {
    this.cb.log?.(...args);
  }
}
