// Drives Crunchyroll's own player instead of the raw <video> element.
//
// Crunchyroll plays videos with Bitmovin, which loads the video piece by piece
// itself. Setting video.currentTime directly bypasses it: it does not load the
// new position and the image freezes ("AbortError" on play).
//
// Jumps, in order of preference:
// 1. the player object (Bitmovin, or Crunchyroll's view model around it),
//    found by exploring what Crunchyroll's controls receive from React
//    ("viewModels", "viewModelContainer"...). Firefox lets extensions read
//    page objects through wrappedJSObject.
// 2. Crunchyroll's "forward / back 10 seconds" buttons (approximate: the sync
//    logic catches up the last seconds by playing slightly faster or slower);
// 3. the <video> element.
// Play and pause go through the <video> unless the player object is known.

import { PlayerDriver } from "./sync";

type Log = (...args: unknown[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SEARCH_RETRY_MS = 4000;
const SEARCH_MAX_ATTEMPTS = 8;
const SEARCH_MAX_NODES = 6000;
const SEARCH_MAX_DEPTH = 7;
const JUMP_SECONDS = 10;
const CLICK_INTERVAL_MS = 80;
const MAX_CLICKS = 150;
const SELECTORS = {
  playPause: '[data-testid="play-pause-button"]',
  playIcon: '[data-testid="play-icon"]',
  forward: '[data-testid="jump-forward-button"]',
  backward: '[data-testid="jump-backward-button"]',
  timeline: '[data-testid="timeline-controls-container"]',
};

function pageObject<T>(value: T): T {
  // Firefox: access the page's own JavaScript objects from the extension
  return ((value as Any)?.wrappedJSObject ?? value) as T;
}

function isFunction(value: Any, name: string): boolean {
  try {
    return typeof value[name] === "function";
  } catch {
    return false;
  }
}

function ownNames(value: Any, max: number): string[] {
  try {
    return Object.getOwnPropertyNames(value).slice(0, max);
  } catch {
    return [];
  }
}

// Method names of an object, including its class (prototype chain)
function methodNames(value: Any): string[] {
  const names = new Set<string>();
  let current = value;
  for (let level = 0; current && level < 4; level++) {
    for (const name of ownNames(current, 120)) {
      if (name !== "constructor" && isFunction(value, name)) names.add(name);
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
    if (current === Object.prototype) break;
  }
  return Array.from(names);
}

function constructorName(value: Any): string {
  try {
    return value?.constructor?.name || "Object";
  } catch {
    return "?";
  }
}

type Kind = "bitmovin" | "viewmodel";

interface Candidate {
  object: Any;
  kind: Kind;
  path: string;
}

function classify(value: Any): Kind | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const seek = isFunction(value, "seek");
  const play = isFunction(value, "play");
  const pause = isFunction(value, "pause");
  if (seek && play && pause && isFunction(value, "getCurrentTime")) return "bitmovin";
  if ((seek || isFunction(value, "seekTo")) && play && pause) return "viewmodel";
  return undefined;
}

export class CrunchyrollDriver implements PlayerDriver {
  private player?: Candidate;
  private lastSearchAt = -Infinity;
  private attempts = 0;
  private reported = false;
  private clickTimer?: ReturnType<typeof setTimeout>;
  // where the 10 s clicks in progress will bring the video
  private virtualPosition?: number;
  // candidates whose seek did not move the video: never used again
  private rejected = new Set<Any>();
  private verified = false;
  private seekCount = 0;

  constructor(private video: HTMLVideoElement, private log: Log) {}

  seek(time: number): number | false {
    const player = this.getPlayer();
    if (player) {
      try {
        this.seekCount++;
        if (isFunction(player.object, "seek")) player.object.seek(time);
        else player.object.seekTo(time);
        if (!this.verified) this.verify(player, time);
        return 0;
      } catch (error) {
        this.log("[driver] seek failed, back to the buttons", String(error));
        this.player = undefined;
      }
    }
    return this.seekWithButtons(time);
  }

  // Play and pause go through the <video>: it works, and when Firefox blocks
  // autoplay the <video> says so (the join button can then be shown), while
  // the player object refuses silently.
  play(): boolean {
    return false;
  }

  pause(): boolean {
    return false;
  }

  // Restart a stuck player the way a viewer would. Only when Crunchyroll's
  // button shows "play": otherwise the click would pause it.
  clickPlay(): boolean {
    const button = document.querySelector<HTMLButtonElement>(SELECTORS.playPause);
    if (!button || !button.querySelector(SELECTORS.playIcon)) return false;
    button.click();
    return true;
  }

  // The first jump through a found object must really move the video,
  // otherwise it was the wrong object
  private verify(player: Candidate, target: number): void {
    const startedAt = this.video.currentTime;
    const seekNumber = this.seekCount;
    setTimeout(() => {
      if (this.player !== player) return;
      if (this.seekCount !== seekNumber) return; // another jump since: judge that one
      const now = this.video.currentTime;
      const moved = Math.abs(now - target) < 4 || Math.abs(target - startedAt) < 4;
      if (moved) {
        this.verified = true;
        this.log("[driver] jump through the player confirmed");
      } else {
        this.log("[driver] that object did not move the video, dropping it", { target, now });
        this.rejected.add(player.object);
        this.player = undefined;
        this.attempts = 0;
        this.seekWithButtons(target + 2.5);
      }
    }, 2500);
  }

  // ---------------------------------------------------------------- jumps with buttons

  private seekWithButtons(time: number): number | false {
    const forward = document.querySelector<HTMLButtonElement>(SELECTORS.forward);
    const backward = document.querySelector<HTMLButtonElement>(SELECTORS.backward);
    if (!forward || !backward) return false;

    // A sequence is running: continue from where it is going, not from where
    // the video is right now (otherwise sequences add up: "plein de jumps")
    const from = this.virtualPosition ?? this.video.currentTime;
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = undefined;

    const delta = time - from;
    const clicks = Math.min(MAX_CLICKS, Math.round(Math.abs(delta) / JUMP_SECONDS));
    if (clicks === 0) {
      this.virtualPosition = undefined;
      return 0; // a few seconds: caught up by speed adjustment
    }
    const direction = delta > 0 ? 1 : -1;
    const button = direction > 0 ? forward : backward;
    this.log("[driver] jumping with Crunchyroll's buttons", { clicks, direction });

    let done = 0;
    this.virtualPosition = from;
    const clickNext = () => {
      this.clickTimer = undefined;
      if (!button.isConnected) {
        this.virtualPosition = undefined;
        return;
      }
      button.click();
      done++;
      this.virtualPosition = from + direction * JUMP_SECONDS * done;
      if (done < clicks) {
        this.clickTimer = setTimeout(clickNext, CLICK_INTERVAL_MS);
      } else {
        this.clickTimer = setTimeout(() => (this.virtualPosition = undefined), 1500);
      }
    };
    clickNext();
    return clicks * CLICK_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- finding the player

  private getPlayer(): Candidate | undefined {
    if (this.player) {
      if (this.stillValid(this.player)) return this.player;
      this.player = undefined;
    }
    if (this.attempts >= SEARCH_MAX_ATTEMPTS) return undefined;
    const now = performance.now();
    if (now - this.lastSearchAt < SEARCH_RETRY_MS) return undefined;
    this.lastSearchAt = now;
    this.attempts++;

    const found = this.search();
    if (found) {
      this.player = found;
      this.log("[driver] Crunchyroll player found, using it", { kind: found.kind, path: found.path, methods: methodNames(found.object).slice(0, 40).join(",") });
    } else if (!this.reported) {
      this.reported = true;
      this.log("[driver] Crunchyroll player not found, using its 10 s buttons for jumps");
    }
    return this.player;
  }

  private stillValid(candidate: Candidate): boolean {
    if (candidate.kind !== "bitmovin") return classify(candidate.object) !== undefined;
    try {
      return Math.abs(candidate.object.getCurrentTime() - this.video.currentTime) < 3;
    } catch {
      return false;
    }
  }

  private fiberOf(element: Element | null): Any {
    for (let level = 0; element && level < 30; level++, element = element.parentElement) {
      const node = pageObject(element) as Any;
      const key = ownNames(node, 300).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (key) return node[key];
    }
    return undefined;
  }

  // Everything the controls get from React: props, hook states, contexts
  private roots(): Array<{ value: Any; path: string }> {
    const roots: Array<{ value: Any; path: string }> = [];
    for (const selector of [SELECTORS.playPause, SELECTORS.forward, SELECTORS.timeline]) {
      let fiber = this.fiberOf(document.querySelector(selector));
      for (let step = 0; fiber && step < 80; step++, fiber = fiber.return) {
        try {
          const type = fiber.type;
          const name = typeof type === "string" ? type : type?.displayName || type?.name || "?";
          if (typeof type !== "string") {
            roots.push({ value: fiber.memoizedProps, path: `${name}.props` });
            let hook = fiber.memoizedState;
            for (let i = 0; hook && typeof hook === "object" && i < 40; i++, hook = hook.next) {
              roots.push({ value: hook.memoizedState, path: `${name}.hook${i}` });
            }
            if (fiber.stateNode && typeof fiber.stateNode.nodeType !== "number") {
              roots.push({ value: fiber.stateNode, path: `${name}.instance` });
            }
          }
          let context = fiber.dependencies?.firstContext;
          for (let i = 0; context && i < 20; i++, context = context.next) {
            roots.push({ value: context.memoizedValue, path: `${name}.context${i}` });
          }
        } catch {
          // keep walking
        }
      }
      if (roots.length) break;
    }
    return roots;
  }

  private search(): Candidate | undefined {
    const roots = this.roots();
    if (!roots.length) {
      this.log("[driver] no React tree found on the controls");
      return undefined;
    }
    const win = pageObject(window) as Any;
    const seen = new Set<Any>();
    const queue: Array<{ value: Any; path: string; depth: number }> = roots.map((r) => ({ ...r, depth: 0 }));
    const viewModels: Candidate[] = [];
    let bitmovin: Candidate | undefined = undefined;
    let visited = 0;

    while (queue.length && visited < SEARCH_MAX_NODES) {
      const { value, path, depth } = queue.shift()!;
      if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited++;

      const kind = this.rejected.has(value) ? undefined : classify(value);
      if (kind === "bitmovin" && !bitmovin) bitmovin = { object: value, kind, path };
      if (kind === "viewmodel") viewModels.push({ object: value, kind, path });

      if (depth >= SEARCH_MAX_DEPTH || value === win) continue;
      try {
        if (typeof value.nodeType === "number") continue; // DOM nodes
      } catch {
        continue;
      }
      if (typeof value === "function") continue;

      // Map / Set contents
      try {
        if (typeof value.size === "number" && isFunction(value, "values")) {
          const iterator = value.values();
          for (let i = 0; i < 200; i++) {
            const next = iterator.next();
            if (next.done) break;
            queue.push({ value: next.value, path: `${path}<${i}>`, depth: depth + 1 });
          }
        }
      } catch {
        // not iterable
      }
      for (const key of ownNames(value, 80)) {
        if (key.startsWith("__react") || key === "children" || key === "_owner") continue;
        let child: Any;
        try {
          child = value[key];
        } catch {
          continue;
        }
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
        }
      }
    }

    // Crunchyroll's own player object (it wraps Bitmovin and keeps its
    // interface up to date) comes first; raw Bitmovin is the backup
    const wrapper = viewModels.find((c) => /\._player$/.test(c.path) && isFunction(c.object, "seek"));
    if (wrapper) return wrapper;
    if (bitmovin) return bitmovin;
    if (viewModels.length) {
      const score = (c: Candidate) =>
        methodNames(c.object).filter((m) => /time|seek|play|pause|duration|position/i.test(m)).length;
      viewModels.sort((a, b) => score(b) - score(a));
      return viewModels[0];
    }

    this.describe(roots, visited);
    return undefined;
  }

  // Debug builds: what the controls can reach, to improve the search later
  private describe(roots: Array<{ value: Any; path: string }>, visited: number): void {
    const lines: string[] = [`visited ${visited}`];
    for (const root of roots.slice(0, 60)) {
      const value = root.value;
      if (!value || typeof value !== "object") continue;
      const names = ownNames(value, 12).filter((n) => !n.startsWith("__react"));
      if (!names.length) continue;
      const parts = names.map((name) => {
        let child: Any;
        try {
          child = value[name];
        } catch {
          return name;
        }
        if (child && typeof child === "object") {
          const methods = methodNames(child).slice(0, 12).join("|");
          return `${name}:${constructorName(child)}${methods ? `{${methods}}` : ""}`;
        }
        return name;
      });
      lines.push(`${root.path}=${parts.join(",")}`);
    }
    this.log("[driver] reachable", lines.join(" ; "));
  }
}
