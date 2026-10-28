// Checks that CrunchyrollDriver finds the player in a React tree shaped like the
// one logged on crunchyroll.com ("[driver] tree"): the controls get a
// viewModelContainer from a context and an ancestor receives `viewModels`.
// Run: bun test/driver.test.ts
import { CrunchyrollDriver } from "../src/crunchyroll_driver";

class BitmovinPlayer {
  time = 100;
  seeks: number[] = [];
  seek(t: number) { this.seeks.push(t); this.time = t; return true; }
  play() { return Promise.resolve(); }
  pause() {}
  getCurrentTime() { return this.time; }
  isPlaying() { return true; }
}
class PlaybackViewModel {
  #player: BitmovinPlayer;
  constructor(p: BitmovinPlayer) { this.#player = p; (this as any).playerApi = p; }
  togglePlay() {}
}
class ViewModelContainer {
  private registry = new Map<string, unknown>();
  register(k: string, v: unknown) { this.registry.set(k, v); }
}

function fakeElement(fiber: any, parent: any = null) {
  return { parentElement: parent, nodeType: 1, ["__reactFiber$abc"]: fiber, isConnected: true, querySelector: () => null, click() {} } as any;
}

function run(name: string, build: (player: BitmovinPlayer) => any) {
  const player = new BitmovinPlayer();
  const buttonFiber = build(player);
  const button = fakeElement(buttonFiber);
  (globalThis as any).document = { querySelector: (sel: string) => (sel.includes("play-pause") ? button : null) };
  (globalThis as any).window = globalThis;
  const video = { currentTime: 100, paused: false } as any;
  const logs: unknown[][] = [];
  const driver = new CrunchyrollDriver(video, (...a) => logs.push(a));
  const result = driver.seek(250);
  const ok = result === 0 && player.seeks[0] === 250;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`, ok ? "" : JSON.stringify(logs).slice(0, 400));
  return ok;
}

function chain(...fibers: any[]) {
  for (let i = 0; i < fibers.length - 1; i++) fibers[i].return = fibers[i + 1];
  return fibers[0];
}

let failures = 0;
// 1. player behind a view model registered in a Map, reached through a context
failures += run("contexte viewModelContainer -> Map -> view model -> lecteur", (player) => {
  const container = new ViewModelContainer();
  container.register("playback", new PlaybackViewModel(player));
  const ctxValue = { accessibilityAnnouncer: {}, localizationManager: {}, viewModelContainer: container, keyboardShortcutTarget: {}, autohiderEventTarget: {} };
  return chain(
    { type: "button", memoizedProps: { onClick() {} } },
    { type: function ih() {}, memoizedProps: { label: "x" } },
    { type: function iK() {}, memoizedProps: {}, dependencies: { firstContext: { memoizedValue: ctxValue, next: null } } },
    { type: function ak() {}, memoizedProps: ctxValue },
  );
}) ? 0 : 1;
// 2. player inside props.viewModels of an ancestor
failures += run("props.viewModels d'un ancêtre", (player) =>
  chain(
    { type: "button", memoizedProps: {} },
    { type: function iZ() {}, memoizedProps: {} },
    { type: function t2() {}, memoizedProps: { viewModels: { playerState: { api: player } } } },
  )) ? 0 : 1;
// 3. player kept in a useRef hook
failures += run("hook useRef", (player) =>
  chain(
    { type: "button", memoizedProps: {} },
    { type: function av() {}, memoizedProps: {}, memoizedState: { memoizedState: 1, next: { memoizedState: { current: player }, next: null } } },
  )) ? 0 : 1;

console.log(failures ? `${failures} échec(s)` : "Le lecteur est trouvé dans les 3 formes testées.");
process.exit(failures ? 1 : 0);
