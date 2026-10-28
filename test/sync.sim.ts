// Simulation of several friends watching together, to check the sync logic
// without a browser. It reproduces:
//  - the rules of the real sync server (roll_together_backend/src/server.ts),
//    including "a join forces the room to paused at its last stored position";
//  - network latency;
//  - a video player that needs time to load when jumping to a part that is not
//    buffered yet, that resumes at its own "continue watching" position when it
//    loads, and a browser that refuses autoplay until the page was clicked.
//
// Each scenario runs with the old content-script logic and with the new one.
// Run: npm run test:sync   (= npx --yes tsx test/sync.sim.ts, or: bun test/sync.sim.ts)
//
// Options (environment variables):
//   SIM_RUNS=1000          number of random sessions (default 200)
//   SIM_SEED=42            replay a single random session with the new logic
//   SIM_TRACE=1            print what each friend's extension does
//   SIM_LAT_MAX=450        worst one-way network latency in ms (default 250)
//   SIM_GAP_MIN/GAP_MAX    time between random actions in ms (default 4000-15000)

import { SyncController, VideoLike } from "../src/sync";
import { States } from "../src/types";

const TRACE = !!process.env.SIM_TRACE;
const LAT_MAX = Number(process.env.SIM_LAT_MAX ?? 250);
const GAP_MIN = Number(process.env.SIM_GAP_MIN ?? 4000);
const GAP_MAX = Number(process.env.SIM_GAP_MAX ?? 15000);

// ------------------------------------------------------------------ event loop

type Task = { t: number; seq: number; fn: () => void };

class Sim {
  now = 0;
  events = 0;
  maxEvents = Infinity;
  private queue: Task[] = [];
  private seq = 0;
  private seed: number;

  constructor(seed = 42) {
    this.seed = seed;
  }

  random(): number {
    // mulberry32
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  at(t: number, fn: () => void): Task {
    const task = { t: Math.max(t, this.now), seq: this.seq++, fn };
    this.queue.push(task);
    return task;
  }

  after(ms: number, fn: () => void): Task {
    return this.at(this.now + ms, fn);
  }

  cancel(task: unknown): void {
    const index = this.queue.indexOf(task as Task);
    if (index >= 0) this.queue.splice(index, 1);
  }

  async runUntil(t: number): Promise<void> {
    let sameTimeEvents = 0;
    let lastTime = -1;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const q = this.queue[i];
        if (
          best < 0 ||
          q.t < this.queue[best].t ||
          (q.t === this.queue[best].t && q.seq < this.queue[best].seq)
        ) {
          best = i;
        }
      }
      if (best < 0 || this.queue[best].t > t) break;
      const task = this.queue.splice(best, 1)[0];
      sameTimeEvents = task.t === lastTime ? sameTimeEvents + 1 : 0;
      lastTime = task.t;
      if (sameTimeEvents > 10000) throw new Error(`event loop stuck at t=${task.t}`);
      if (++this.events > this.maxEvents) throw new Error("message storm");
      this.now = task.t;
      task.fn();
      // let promise callbacks (play() rejections...) run, like a real event loop
      for (let i = 0; i < 4; i++) await Promise.resolve();
    }
    this.now = t;
  }
}

// ------------------------------------------------------------------ fake player

// Players keep about 30 s loaded ahead of the current position
const FORWARD_BUFFER_S = 30;

// Behaviours seen in real players, toggled per scenario
interface Quirks {
  // Firefox fires "timeupdate" as soon as a seek starts
  timeupdateOnSeekStart?: boolean;
  // the player pauses itself while a jump loads, then resumes (seen on
  // Crunchyroll when the jump comes from outside its own controls)
  pauseWhileLoadingSeek?: boolean;
  // after a far jump made from outside its controls, the player stays frozen:
  // "playing" but the image does not move, until pause/play or a new jump
  freezeAfterExternalSeek?: boolean;
  // how long after the jump the self-paused player starts again (ms)
  resumeDelayMs?: number;
  // Crunchyroll on arrival: a jump made from outside while the player is still
  // starting (loading, going to its resume point) leaves it frozen
  freezeIfMovedDuringStartup?: boolean;
  // Crunchyroll's Bitmovin player: any jump made on the <video> itself freezes
  // it, and a play() on the <video> then fails (AbortError). Jumps and
  // play/pause made through the player (the driver) work.
  bitmovin?: boolean;
  // the extension can reach the player object (otherwise only its button)
  driverFindsPlayer?: boolean;
}

class FakePlayer implements VideoLike {
  quirks: Quirks = {};
  private rate = 1;
  paused = true;
  readyState = 0;
  seeking = false;
  duration = NaN;
  activated = false; // the user has clicked/typed on the page
  autoplayAllowed = false; // Firefox default: blocked until the page is clicked
  seekCount = 0;

  private listeners = new Map<string, Set<() => void>>();
  private pos = 0;
  private posAt = 0;
  private stalled = true;
  private buffered: Array<[number, number]> = [];
  private seekTask?: Task;
  private firstCanPlay = true;
  private userSeeking = false;
  private internalSeeking = false;
  private startedAt = Infinity;
  frozen = false;
  private autoplayOnLoad = false;

  constructor(private sim: Sim, readonly name: string, private bufferDelayMs: number) {
    const tick = () => {
      if (!this.paused && !this.stalled && !this.seeking) {
        const t = this.currentTime;
        this.addBuffered(t, t + FORWARD_BUFFER_S);
        this.fire("timeupdate");
      }
      this.sim.after(250, tick);
    };
    this.sim.after(250, tick);
  }

  get currentTime(): number {
    if (!this.paused && !this.stalled && !this.seeking) {
      return Math.min(this.duration || Infinity, this.pos + (this.rate * (this.sim.now - this.posAt)) / 1000);
    }
    return this.pos;
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(rate: number) {
    this.freeze();
    this.rate = rate;
  }

  set currentTime(target: number) {
    const fromUser = this.userSeeking || this.internalSeeking;
    this.userSeeking = false;
    this.internalSeeking = false;
    const duringStartup = this.sim.now < this.startedAt + 1000;
    this.frozen = false;
    this.freeze();
    this.pos = target;
    this.posAt = this.sim.now;
    if (this.readyState === 0) return; // remembered as start position, overridden by the player on load
    this.seekCount++;
    this.seeking = true;
    this.fire("seeking");
    if (this.quirks.timeupdateOnSeekStart) this.fire("timeupdate");
    const isBuffered = this.isBuffered(target);
    let resumeAfterLoad = false;
    if (!this.paused && this.quirks.pauseWhileLoadingSeek) {
      this.paused = true;
      this.fire("pause");
      resumeAfterLoad = true;
    }
    if (!isBuffered) {
      this.readyState = 1;
      this.stalled = true;
      if (!this.paused) this.fire("waiting");
    }
    if (this.seekTask) this.sim.cancel(this.seekTask);
    this.seekTask = this.sim.after(isBuffered ? 30 : this.bufferDelayMs, () => {
      this.seekTask = undefined;
      this.addBuffered(target, target + FORWARD_BUFFER_S);
      this.seeking = false;
      this.readyState = 4;
      const wasStalled = this.stalled;
      this.stalled = false;
      if (
        !fromUser &&
        (this.quirks.bitmovin ||
          (this.quirks.freezeAfterExternalSeek && !isBuffered) ||
          (this.quirks.freezeIfMovedDuringStartup && duringStartup))
      ) {
        this.stalled = true;
        this.frozen = true;
      }
      this.posAt = this.sim.now;
      this.fire("timeupdate");
      this.fire("seeked");
      if (resumeAfterLoad) {
        this.sim.after(this.quirks.resumeDelayMs ?? 0, () => {
          if (!this.paused) return;
          this.freeze();
          this.paused = false;
          this.frozen = false;
          this.posAt = this.sim.now;
          this.fire("play");
          this.fire("playing");
        });
      }
      if (this.firstCanPlay) {
        this.firstCanPlay = false;
        this.startedAt = this.sim.now;
        this.fire("canplay");
        if (this.autoplayOnLoad) this.play()?.catch(() => undefined);
      }
      if (!this.paused && wasStalled && !this.frozen) this.fire("playing");
    });
  }

  // Crunchyroll page load: metadata after loadMs, then the player jumps to the
  // user's own "continue watching" position and may try to autoplay.
  load(loadMs: number, resumeAt: number, autoplay: boolean): void {
    this.autoplayOnLoad = autoplay;
    this.sim.after(loadMs, () => {
      this.readyState = 1;
      this.duration = 1440;
      this.fire("loadedmetadata");
      this.fire("durationchange");
      this.startedAt = this.sim.now;
      this.internalSeeking = true; // the player's own resume point
      this.currentTime = resumeAt;
    });
  }

  play(viaPlayer = false): Promise<void> {
    if (this.quirks.bitmovin && this.frozen && !viaPlayer) {
      const error = new Error("aborted") as Error & { name: string };
      error.name = "AbortError";
      return Promise.reject(error);
    }
    if (!this.autoplayAllowed && !this.activated) {
      const error = new Error("play() blocked") as Error & { name: string };
      error.name = "NotAllowedError";
      return Promise.reject(error);
    }
    if (this.paused) {
      this.freeze();
      this.paused = false;
      this.frozen = false;
      this.posAt = this.sim.now;
      this.fire("play");
      if (this.readyState >= 3 && !this.seeking) {
        this.stalled = false;
        this.fire("playing");
      }
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.freeze();
    this.paused = true;
    this.fire("pause");
  }

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  // --- user actions
  pressSpace(): void {
    this.activated = true;
    if (this.paused) this.play();
    else this.pause();
  }

  // jump made through the player itself (Bitmovin API)
  playerSeek(t: number): void {
    this.internalSeeking = true;
    this.currentTime = t;
  }

  userSeek(t: number): void {
    this.activated = true;
    this.userSeeking = true;
    this.currentTime = t;
  }

  private freeze(): void {
    this.pos = this.currentTime;
    this.posAt = this.sim.now;
  }

  private isBuffered(t: number): boolean {
    return this.buffered.some(([start, end]) => t >= start && t < end - 1);
  }

  private addBuffered(start: number, end: number): void {
    this.buffered.push([start, end]);
    if (this.buffered.length > 50) this.buffered.shift();
  }

  private fire(type: string): void {
    // media events are queued tasks, not synchronous callbacks
    this.sim.after(0, () => this.listeners.get(type)?.forEach((fn) => fn()));
  }
}

// ------------------------------------------------------------------ fake server (same rules as server.ts)

interface Conn {
  id: string; // socket id, new for every connection
  latencyMs: number;
  onJoin(roomId: string, state: States, progress: number, count: number): void;
  onUpdate(senderId: string, state: States, progress: number, count: number): void;
}

class FakeServer {
  rooms: {
    [id: string]: {
      state: States;
      progress: { value: number; lastUpdate: number };
      users: Set<Conn>;
    };
  } = {};
  private lastDelivery = new Map<Conn, number>();
  private nextRoom = 1;

  constructor(private sim: Sim) {}

  connect(conn: Conn, roomId: string | undefined, videoProgress: number): void {
    const id = roomId || `room${this.nextRoom++}`;
    const initial = parseInt(`${Math.round(videoProgress)}`);
    if (!this.rooms[id]) {
      this.rooms[id] = {
        state: States.PAUSED,
        progress: { value: initial, lastUpdate: this.sim.now },
        users: new Set(),
      };
    }
    const room = this.rooms[id];
    room.state = States.PAUSED; // the real server does this on every join
    room.users.add(conn);
    const count = room.users.size;
    const progress = this.progress(id);
    this.deliver(conn, () => conn.onJoin(id, room.state, progress, count));
    for (const other of room.users) {
      if (other !== conn) this.deliver(other, () => other.onUpdate(conn.id, room.state, progress, count));
    }
  }

  update(conn: Conn, roomId: string, state: States, videoProgress: number): void {
    const room = this.rooms[roomId];
    if (!room) return;
    room.state = state;
    room.progress = { value: videoProgress, lastUpdate: this.sim.now };
    const progress = this.progress(roomId);
    const count = room.users.size;
    for (const other of room.users) {
      if (other !== conn) this.deliver(other, () => other.onUpdate(conn.id, state, progress, count));
    }
  }

  disconnect(conn: Conn, roomId: string): void {
    const room = this.rooms[roomId];
    if (!room) return;
    room.users.delete(conn);
    if (room.users.size === 0) delete this.rooms[roomId];
  }

  private progress(roomId: string): number {
    const room = this.rooms[roomId];
    const extra =
      room.state === States.PLAYING ? (this.sim.now - room.progress.lastUpdate) / 1000 : 0;
    return room.progress.value + extra;
  }

  private deliver(conn: Conn, fn: () => void): void {
    // in-order delivery (websocket), with the connection latency
    const t = Math.max(this.sim.now + conn.latencyMs, this.lastDelivery.get(conn) ?? 0);
    this.lastDelivery.set(conn, t);
    this.sim.at(t, fn);
  }
}

// ------------------------------------------------------------------ clients

abstract class Client implements Conn {
  id: string;
  private connections = 0;
  roomId?: string;
  overlayShownAt?: number;
  broadcasts = 0;
  pausesSent = 0;

  constructor(
    protected sim: Sim,
    protected server: FakeServer,
    readonly name: string,
    readonly latencyMs: number,
    readonly player: FakePlayer
  ) {
    this.id = name;
  }

  abstract snapshotProgress(): number;
  abstract onJoin(roomId: string, state: States, progress: number, count: number): void;
  abstract onUpdate(senderId: string, state: States, progress: number, count: number): void;

  connect(roomId?: string): void {
    this.id = `${this.name}#${++this.connections}`;
    const progress = this.snapshotProgress();
    this.sim.after(this.latencyMs, () => this.server.connect(this, roomId, progress));
  }

  reconnect(): void {
    const roomId = this.roomId!;
    this.server.disconnect(this, roomId);
    this.sim.after(1500, () => this.connect(roomId));
  }

  protected send(state: States, progress: number): void {
    this.broadcasts++;
    if (state === States.PAUSED) this.pausesSent++;
    const roomId = this.roomId;
    if (!roomId) return;
    this.sim.after(this.latencyMs, () => this.server.update(this, roomId, state, progress));
  }
}

// The new logic (src/sync.ts) behind the same plumbing as the background script
class NewClient extends Client {
  ctrl: SyncController;

  constructor(sim: Sim, server: FakeServer, id: string, latencyMs: number, player: FakePlayer, clickDelayMs = 2500) {
    super(sim, server, id, latencyMs, player);
    this.ctrl = new SyncController(
      {
        now: () => sim.now,
        setTimeout: (fn, ms) => sim.after(ms, fn),
        clearTimeout: (task) => sim.cancel(task),
        random: () => sim.random(),
      },
      {
        send: (state, progress) => this.send(state, progress),
        log: TRACE ? (...args) => console.log(`${(sim.now / 1000).toFixed(2)} ${id}`, ...args) : undefined,
        onAutoplayBlocked: (blocked) => {
          if (!blocked) {
            this.overlayShownAt = undefined;
            return;
          }
          // the "join playback" button appears; the friend clicks it after a moment
          const shownAt = (this.overlayShownAt = sim.now);
          sim.after(clickDelayMs, () => {
            if (this.overlayShownAt !== shownAt) return;
            this.overlayShownAt = undefined;
            this.player.activated = true;
            this.ctrl.resumeFromUserGesture();
          });
        },
      }
    );
    // quirks are set after creation: decide at call time
    this.ctrl.setDriver({
      seek: (t) => {
        if (!player.quirks.bitmovin || !player.quirks.driverFindsPlayer) return false;
        player.playerSeek(t);
        return true;
      },
      play: () => {
        if (!player.quirks.bitmovin || !player.quirks.driverFindsPlayer) return false;
        if (player.paused) player.play(true).catch(() => undefined);
        return true;
      },
      clickPlay: () => {
        if (!player.quirks.bitmovin) return false;
        // a click on Crunchyroll's play button (only works once the page was clicked)
        if (player.paused && player.activated) player.play(true).catch(() => undefined);
        return true;
      },
      pause: () => {
        if (!player.quirks.bitmovin) return false;
        if (!player.paused) player.pause();
        return true;
      },
    });
    this.ctrl.attach(player);
  }

  snapshotProgress(): number {
    return this.ctrl.snapshot().progress;
  }

  onJoin(roomId: string, state: States, progress: number, count: number): void {
    const rejoin = this.roomId === roomId;
    this.roomId = roomId;
    this.ctrl.handleRemote({ kind: "join", rejoin, state, progress, userCount: count });
  }

  onUpdate(sender: string, state: States, progress: number, count: number): void {
    this.ctrl.handleRemote({ kind: "update", state, progress, userCount: count, senderId: sender });
  }
}

// Faithful port of the previous content_script.ts logic
class OldClient extends Client {
  private ignoreNext: { [action: string]: boolean } = {};
  private lastFrame?: number;
  private playPromise?: Promise<void>;

  constructor(sim: Sim, server: FakeServer, id: string, latencyMs: number, player: FakePlayer) {
    super(sim, server, id, latencyMs, player);
    for (const action of ["play", "pause", "ready", "ended", "timeupdate"]) {
      player.addEventListener(action, () => this.handleLocal(action));
    }
  }

  snapshotProgress(): number {
    return this.getStates().currentProgress;
  }

  private getStates() {
    const paused = this.player.paused;
    const currentProgress = this.player.currentTime;
    this.lastFrame = this.lastFrame || currentProgress;
    const timeJump = Math.abs(currentProgress - this.lastFrame) > 3;
    this.lastFrame = currentProgress;
    return { state: paused ? States.PAUSED : States.PLAYING, currentProgress, timeJump };
  }

  private handleLocal(action: string): void {
    if (this.ignoreNext[action] === true) {
      this.ignoreNext[action] = false;
      return;
    }
    const { state, currentProgress, timeJump } = this.getStates();
    if (action === "play" || action === "pause") this.send(state, currentProgress);
    else if (action === "timeupdate" && timeJump) this.send(state, currentProgress);
  }

  private trigger(action: string, progress: number): void {
    this.ignoreNext[action] = true;
    const p = this.player;
    switch (action) {
      case "pause":
        if (this.playPromise) {
          this.playPromise
            .then(() => {
              p.pause();
              p.currentTime = progress;
            })
            .catch(() => undefined);
          this.playPromise = undefined;
        } else {
          p.pause();
          p.currentTime = progress;
        }
        break;
      case "play":
        this.playPromise = p.play();
        this.playPromise.catch(() => undefined);
        if (Math.abs(p.currentTime - progress) > 3) p.currentTime = progress;
        break;
      case "timeupdate":
        p.currentTime = progress;
        break;
    }
  }

  private handleRemote(roomState: States, roomProgress: number): void {
    const { state, currentProgress } = this.getStates();
    if (state !== roomState) {
      if (roomState === States.PAUSED) this.trigger("pause", roomProgress);
      if (roomState === States.PLAYING) this.trigger("play", roomProgress);
    }
    if (Math.abs(roomProgress - currentProgress) > 3) this.trigger("timeupdate", roomProgress);
  }

  onJoin(roomId: string, state: States, progress: number): void {
    this.roomId = roomId;
    this.handleRemote(state, progress);
  }

  onUpdate(_sender: string, state: States, progress: number): void {
    this.handleRemote(state, progress);
  }
}

// ------------------------------------------------------------------ scenarios

type Kind = "old" | "new";

interface Friend {
  client: Client;
  player: FakePlayer;
}

function makeFriend(
  sim: Sim,
  server: FakeServer,
  kind: Kind,
  name: string,
  opts: { latencyMs?: number; bufferMs?: number; clickDelayMs?: number } = {}
): Friend {
  const player = new FakePlayer(sim, name, opts.bufferMs ?? 1500);
  const latency = opts.latencyMs ?? 60;
  const client =
    kind === "new"
      ? new NewClient(sim, server, name, latency, player, opts.clickDelayMs)
      : new OldClient(sim, server, name, latency, player);
  return { client, player };
}

// A friend already watching (page loaded, has clicked on the page)
function readyFriend(
  sim: Sim,
  server: FakeServer,
  kind: Kind,
  name: string,
  opts: { latencyMs?: number; bufferMs?: number; startAt?: number } = {}
): Friend {
  const friend = makeFriend(sim, server, kind, name, opts);
  friend.player.activated = true;
  friend.player.load(300, opts.startAt ?? 0, false);
  return friend;
}

interface Result {
  [metric: string]: string | number;
}

function spread(friends: Friend[]): number {
  const times = friends.map((f) => f.player.currentTime);
  return Math.max(...times) - Math.min(...times);
}

function states(friends: Friend[]): string {
  return friends.map((f) => (f.player.paused ? "pause" : "play")).join("/");
}

async function measure(sim: Sim, friends: Friend[], from: number, to: number) {
  let worst = 0;
  for (let t = from; t <= to; t += 250) {
    await sim.runUntil(t);
    worst = Math.max(worst, spread(friends));
  }
  return worst;
}

const fmt = (x: number) => `${x.toFixed(1)} s`;

// 1. Watching together, A clicks "skip intro" (jump of 85 s)
async function skipIntro(kind: Kind, bufferA: number, bufferB: number, quirks: Quirks = {}): Promise<Result> {
  const sim = new Sim();
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { bufferMs: bufferA, latencyMs: 50 });
  const b = readyFriend(sim, server, kind, "B", { bufferMs: bufferB, latencyMs: 90 });
  a.player.quirks = quirks;
  b.player.quirks = quirks;
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  b.client.connect(a.client.roomId);
  await sim.runUntil(8000);
  a.player.pressSpace(); // start the episode together
  await sim.runUntil(60000);
  const seeksBefore = a.player.seekCount + b.player.seekCount;
  const pausesBefore = a.client.pausesSent + b.client.pausesSent;
  const t0 = sim.now;
  const introEnd = a.player.currentTime + 85;
  a.player.userSeek(introEnd); // "Skip intro" jumps to the end of the opening
  const worst = await measure(sim, [a, b], t0 + 6000, t0 + 30000);
  const seeks = a.player.seekCount + b.player.seekCount - seeksBefore;
  return {
    "écart max (6 à 30 s après le skip)": fmt(worst),
    "écart final": fmt(spread([a, b])),
    "sauts de lecture": seeks,
    "pauses envoyées par erreur": a.client.pausesSent + b.client.pausesSent - pausesBefore,
    états: states([a, b]),
  };
}

// 2. Both friends click "skip intro", 0.6 s apart
async function bothSkip(kind: Kind): Promise<Result> {
  const sim = new Sim(7);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { bufferMs: 1800, latencyMs: 50 });
  const b = readyFriend(sim, server, kind, "B", { bufferMs: 1200, latencyMs: 90 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  b.client.connect(a.client.roomId);
  await sim.runUntil(8000);
  a.player.pressSpace();
  await sim.runUntil(60000);
  const seeksBefore = a.player.seekCount + b.player.seekCount;
  const t0 = sim.now;
  const introEnd = a.player.currentTime + 85;
  a.player.userSeek(introEnd);
  await sim.runUntil(t0 + 600);
  b.player.userSeek(introEnd); // same button, same target
  const worst = await measure(sim, [a, b], t0 + 6000, t0 + 30000);
  return {
    "écart max (6 à 30 s après)": fmt(worst),
    "écart final": fmt(spread([a, b])),
    "sauts de lecture": a.player.seekCount + b.player.seekCount - seeksBefore,
    états: states([a, b]),
  };
}

// 3. First launch: A creates the room, B opens the link. B's Crunchyroll resumes
//    at B's own "continue watching" position and Firefox blocks autoplay.
async function firstLaunch(kind: Kind): Promise<Result> {
  const sim = new Sim(3);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { latencyMs: 50 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);

  const b = makeFriend(sim, server, kind, "B", { latencyMs: 90, bufferMs: 2000, clickDelayMs: 2500 });
  b.player.load(2500, 312, true); // B had watched up to 5:12 before
  b.client.connect(a.client.roomId); // the extension connects before the player has loaded
  await sim.runUntil(9000);
  a.player.pressSpace(); // A starts the episode
  const t0 = sim.now;
  await sim.runUntil(t0 + 12000);
  return {
    "écart 12 s après le lancement": fmt(spread([a, b])),
    états: states([a, b]),
    "position A": fmt(a.player.currentTime),
  };
}

// 3b. Same arrival, with a player that freezes if moved while starting
async function firstLaunchFragile(kind: Kind): Promise<Result> {
  const sim = new Sim(4);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { latencyMs: 50 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  a.player.pressSpace(); // A already watching
  await sim.runUntil(25000);
  const b = makeFriend(sim, server, kind, "B", { latencyMs: 90, bufferMs: 2000, clickDelayMs: 2000 });
  b.player.quirks = { freezeIfMovedDuringStartup: true, pauseWhileLoadingSeek: true, resumeDelayMs: 300 };
  b.player.activated = true;
  b.player.load(2500, 134, true); // B had watched up to 2:14 before
  b.client.connect(a.client.roomId);
  await sim.runUntil(25000 + 12000);
  return {
    "écart 12 s après l'arrivée de B": fmt(spread([a, b])),
    états: states([a, b]),
    "position A": fmt(a.player.currentTime),
  };
}

// 4. A and B watch since the beginning, C joins 5 minutes in
async function lateJoin(kind: Kind): Promise<Result> {
  const sim = new Sim(11);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { latencyMs: 50 });
  const b = readyFriend(sim, server, kind, "B", { latencyMs: 90 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  b.client.connect(a.client.roomId);
  await sim.runUntil(8000);
  a.player.pressSpace();
  await sim.runUntil(300000);
  const before = a.player.currentTime;

  const c = makeFriend(sim, server, kind, "C", { latencyMs: 70, bufferMs: 1500, clickDelayMs: 2000 });
  c.player.load(2000, 0, true);
  c.client.connect(a.client.roomId);
  await sim.runUntil(300000 + 15000);
  return {
    "position de A avant l'arrivée de C": fmt(before),
    "position de A 15 s après": fmt(a.player.currentTime),
    "écart A/B/C": fmt(spread([a, b, c])),
    états: states([a, b, c]),
  };
}

// 5. B's connection drops and comes back while watching
async function reconnect(kind: Kind): Promise<Result> {
  const sim = new Sim(5);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { latencyMs: 50 });
  const b = readyFriend(sim, server, kind, "B", { latencyMs: 90 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  b.client.connect(a.client.roomId);
  await sim.runUntil(8000);
  a.player.pressSpace();
  await sim.runUntil(200000);
  const before = a.player.currentTime;
  b.client.reconnect();
  await sim.runUntil(215000);
  return {
    "position de A avant la coupure": fmt(before),
    "position de A 15 s après": fmt(a.player.currentTime),
    "écart final": fmt(spread([a, b])),
    états: states([a, b]),
  };
}

// 6. Pause / play pressed by two friends at almost the same time
async function crossedActions(kind: Kind): Promise<Result> {
  const sim = new Sim(9);
  const server = new FakeServer(sim);
  const a = readyFriend(sim, server, kind, "A", { latencyMs: 50 });
  const b = readyFriend(sim, server, kind, "B", { latencyMs: 90 });
  await sim.runUntil(2000);
  a.client.connect();
  await sim.runUntil(3000);
  b.client.connect(a.client.roomId);
  await sim.runUntil(8000);
  a.player.pressSpace();
  await sim.runUntil(40000);
  a.player.pressSpace(); // A pauses
  await sim.runUntil(40050);
  b.player.userSeek(b.player.currentTime + 10); // B jumps 10 s at the same moment
  await sim.runUntil(46000);
  a.player.pressSpace(); // A resumes
  await sim.runUntil(55000);
  return {
    "écart final": fmt(spread([a, b])),
    états: states([a, b]),
  };
}


// 7. Random sessions: 2 to 4 friends, random connections and loading times,
//    random skips / pauses / jumps. After the last action everybody must end up
//    together and the extension must go quiet (no endless corrections).
async function randomSession(kind: Kind, seed: number) {
  try {
    return await randomSessionUnsafe(kind, seed);
  } catch (error) {
    // the extension flooded the room with messages (endless back-and-forth)
    if ((error as Error).message === "message storm") {
      return { gap: Infinity, sameState: false, lateBroadcasts: Infinity, count: 0 };
    }
    throw error;
  }
}

async function randomSessionUnsafe(kind: Kind, seed: number) {
  const sim = new Sim(seed);
  sim.maxEvents = 400000;
  const server = new FakeServer(sim);
  const rnd = (min: number, max: number) => min + sim.random() * (max - min);
  const count = 2 + Math.floor(sim.random() * 3);
  const friends: Friend[] = [];
  for (let i = 0; i < count; i++) {
    const friend = readyFriend(sim, server, kind, `F${i}`, {
      latencyMs: rnd(30, LAT_MAX),
      bufferMs: rnd(300, 6000),
    });
    friend.player.quirks = {
      timeupdateOnSeekStart: sim.random() < 0.5,
      pauseWhileLoadingSeek: sim.random() < 0.3,
      freezeAfterExternalSeek: sim.random() < 0.3,
      resumeDelayMs: sim.random() < 0.5 ? 0 : rnd(100, 3000),
    };
    if (sim.random() < 0.3) {
      friend.player.quirks = { bitmovin: true, driverFindsPlayer: sim.random() < 0.6, pauseWhileLoadingSeek: true, resumeDelayMs: rnd(0, 500) };
    }
    friends.push(friend);
  }
  await sim.runUntil(2000);
  friends[0].client.connect();
  await sim.runUntil(3000);
  for (let i = 1; i < count; i++) {
    friends[i].client.connect(friends[0].client.roomId);
    await sim.runUntil(sim.now + rnd(500, 2000));
  }
  await sim.runUntil(10000);
  friends[0].player.pressSpace();

  let t = 20000;
  let lateJoinerAdded = false;
  while (t < 120000) {
    await sim.runUntil(t);
    if (!lateJoinerAdded && sim.random() < 0.15) {
      // a friend arrives late through the link: page loading, own resume
      // position, autoplay blocked until the button is clicked
      lateJoinerAdded = true;
      const late = makeFriend(sim, server, kind, "late", {
        latencyMs: rnd(30, LAT_MAX),
        bufferMs: rnd(300, 6000),
        clickDelayMs: rnd(1000, 6000),
      });
      late.player.quirks = { freezeIfMovedDuringStartup: sim.random() < 0.5 };
      late.player.load(rnd(500, 4000), Math.floor(rnd(0, 900)), sim.random() < 0.5);
      late.client.connect(friends[0].client.roomId);
      friends.push(late);
      t += rnd(GAP_MIN, GAP_MAX);
      continue;
    }
    if (sim.random() < 0.05) {
      // someone's connection drops for a moment
      friends[Math.floor(sim.random() * friends.length)].client.reconnect();
      t += rnd(GAP_MIN, GAP_MAX);
      continue;
    }
    const actor = friends[Math.floor(sim.random() * count)].player;
    const r = sim.random();
    if (r < 0.4) actor.userSeek(actor.currentTime + 85);
    else if (r < 0.6) actor.pressSpace();
    else if (r < 0.8) actor.userSeek(actor.currentTime + (sim.random() < 0.5 ? -10 : 10));
    else actor.userSeek(Math.max(0, actor.currentTime - 30));
    t += rnd(GAP_MIN, GAP_MAX);
  }
  // make sure the session ends playing, then let it settle
  await sim.runUntil(t);
  if (friends[0].player.paused) friends[0].player.pressSpace();
  await sim.runUntil(t + 20000);
  const broadcastsBefore = friends.reduce((n, f) => n + f.client.broadcasts, 0);
  await sim.runUntil(t + 30000);
  const lateBroadcasts = friends.reduce((n, f) => n + f.client.broadcasts, 0) - broadcastsBefore;
  const sameState = new Set(friends.map((f) => f.player.paused)).size === 1;
  if (TRACE) {
    for (const f of friends) {
      const c = (f.client as any).ctrl;
      console.log(f.player.name, f.player.paused ? "paused" : "playing", f.player.currentTime.toFixed(2), "ready", f.player.readyState, "activated", f.player.activated, c && { room: c.room, seekStartedAt: c.seekStartedAt, lastActivityAt: c.lastActivityAt, lastDriftFixAt: c.lastDriftFixAt, awaiting: c.awaitingInitialSync, blocked: c.autoplayBlocked, inRoom: c.inRoom, now: sim.now });
    }
  }
  return { gap: spread(friends), sameState, lateBroadcasts, count: friends.length };
}

async function fuzz(runs: number) {
  console.log(`\n## ${runs} séances aléatoires (2 à 4 potes, chargements de 0,3 à 6 s)`);
  for (const kind of ["old", "new"] as Kind[]) {
    let ok = 0;
    let worst = 0;
    let noisy = 0;
    const failed: number[] = [];
    for (let seed = 1; seed <= runs; seed++) {
      if (process.env.SIM_PROGRESS) console.log(kind, seed);
      const r = await randomSession(kind, seed);
      worst = Math.max(worst, r.gap);
      if (r.lateBroadcasts > 0) noisy++;
      if (r.gap <= 1.5 && r.sameState) ok++;
      else failed.push(seed);
      if (kind === "new" && (r.gap > 3 || !r.sameState)) console.log(`  séance ${seed} : écart ${fmt(r.gap)}, mêmes états: ${r.sameState}`);
    }
    console.log(
      `  ${kind === "old" ? "avant" : "après"}: ${ok}/${runs} séances synchronisées à la fin` +
        ` (écart max ${fmt(worst)}, ${noisy} séances encore agitées)` +
        (kind === "new" && failed.length ? ` — graines en échec: ${failed.slice(0, 10).join(", ")}` : "")
    );
    if (kind === "new" && (ok < runs || noisy > 0)) return false;
  }
  return true;
}

async function main() {
  if (process.env.SIM_SEED) {
    console.log(await randomSession("new", Number(process.env.SIM_SEED)));
    return;
  }
  const scenarios: Array<[string, (k: Kind) => Promise<Result>]> = [
    ["Skip de l'opening (A charge en 2,5 s, B en 1 s)", (k) => skipIntro(k, 2500, 1000)],
    ["Skip de l'opening (A charge en 1 s, B en 3 s)", (k) => skipIntro(k, 1000, 3000)],
    [
      "Skip, lecteur qui signale le saut dès le début (Firefox)",
      (k) => skipIntro(k, 1000, 4000, { timeupdateOnSeekStart: true }),
    ],
    [
      "Skip, lecteur qui se met en pause pendant le chargement",
      (k) => skipIntro(k, 2500, 1200, { pauseWhileLoadingSeek: true }),
    ],
    [
      "Skip, lecteur qui se met en pause et repart 2,5 s après",
      (k) => skipIntro(k, 1200, 2000, { pauseWhileLoadingSeek: true, resumeDelayMs: 2500 }),
    ],
    [
      "Skip, lecteur Crunchyroll (Bitmovin) piloté par l'extension",
      (k) => skipIntro(k, 1000, 2000, { bitmovin: true, driverFindsPlayer: true, pauseWhileLoadingSeek: true, resumeDelayMs: 200 }),
    ],
    [
      "Skip, lecteur Crunchyroll, seulement son bouton play/pause",
      (k) => skipIntro(k, 1000, 2000, { bitmovin: true, pauseWhileLoadingSeek: true, resumeDelayMs: 200 }),
    ],
    [
      "Skip, le lecteur du pote reste figé après le saut",
      (k) => skipIntro(k, 1000, 2000, { pauseWhileLoadingSeek: true, freezeAfterExternalSeek: true }),
    ],
    [
      "Skip, les deux comportements + chargements lents",
      (k) => skipIntro(k, 1500, 5000, { timeupdateOnSeekStart: true, pauseWhileLoadingSeek: true }),
    ],
    ["Les deux cliquent sur « Passer l'intro »", bothSkip],
    ["Premier lancement (B arrive par le lien)", firstLaunch],
    ["B arrive pendant la lecture, lecteur fragile au démarrage", firstLaunchFragile],
    ["C rejoint après 5 min de visionnage", lateJoin],
    ["Coupure réseau de B pendant la lecture", reconnect],
    ["Pause et saut presque simultanés", crossedActions],
  ];

  let failures = 0;
  for (const [title, run] of scenarios) {
    console.log(`\n## ${title}`);
    const old = await run("old");
    const neu = await run("new");
    const keys = Array.from(new Set([...Object.keys(old), ...Object.keys(neu)]));
    for (const key of keys) {
      console.log(`  ${key.padEnd(40)} avant: ${String(old[key] ?? "-").padEnd(16)} après: ${neu[key] ?? "-"}`);
    }
    const finalKey = keys.find((k) => k.startsWith("écart"))!;
    const finalGap = parseFloat(String(neu[keys.filter((k) => k.startsWith("écart")).pop()!]));
    const allPlaying = !String(neu["états"]).includes("pause") || title.includes("Pause");
    const spuriousPauses = Number(neu["pauses envoyées par erreur"] ?? 0);
    if (!(finalGap <= 2.5) || !allPlaying || spuriousPauses > 0) {
      failures++;
      console.log(`  !! nouvelle version pas synchronisée (${finalKey})`);
    }
  }

  const runs = Number(process.env.SIM_RUNS ?? 200);
  if (!(await fuzz(runs))) failures++;

  if (failures > 0) {
    console.log(`\n${failures} scénario(s) en échec`);
    process.exit(1);
  }
  console.log("\nTous les scénarios finissent synchronisés avec la nouvelle version.");
}

main();
