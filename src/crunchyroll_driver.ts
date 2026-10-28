// Drives Crunchyroll's own player instead of the raw <video> element.
//
// Crunchyroll plays videos with Bitmovin, which loads the video piece by piece
// itself. Setting video.currentTime directly bypasses it: it does not load the
// new position and the image freezes ("AbortError" on play). Going through the
// player keeps it in charge.
//
// Jumps, in order of preference:
// 1. the Bitmovin player object (seek), found in the page's React tree
//    (Firefox lets extensions read page objects through wrappedJSObject);
// 2. Crunchyroll's "forward / back 10 seconds" buttons, clicked as many times
//    as needed (the remaining few seconds are caught up by the sync logic by
//    playing slightly faster or slower);
// 3. the <video> element.
// Play and pause go through the <video>, which works; the play button is only
// pressed to restart a stuck player, and only when it shows "play".

import { PlayerDriver } from "./sync";

type Log = (...args: unknown[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SEARCH_RETRY_MS = 3000;
const JUMP_SECONDS = 10;
const CLICK_INTERVAL_MS = 60;
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

function isBitmovinPlayer(candidate: Any): boolean {
  try {
    return (
      !!candidate &&
      typeof candidate === "object" &&
      typeof candidate.seek === "function" &&
      typeof candidate.play === "function" &&
      typeof candidate.pause === "function" &&
      typeof candidate.getCurrentTime === "function"
    );
  } catch {
    return false;
  }
}

function keysOf(value: Any, max: number): string[] {
  try {
    return Object.keys(value).slice(0, max);
  } catch {
    return [];
  }
}

export class CrunchyrollDriver implements PlayerDriver {
  private player: Any = undefined;
  private lastSearchAt = -Infinity;
  private reported = false;
  private clickTimer?: ReturnType<typeof setTimeout>;

  constructor(private video: HTMLVideoElement, private log: Log) {}

  seek(time: number): number | false {
    const player = this.getPlayer();
    if (player) {
      try {
        player.seek(time);
        return 0;
      } catch (error) {
        this.log("[driver] seek failed", error);
        this.player = undefined;
      }
    }
    return this.seekWithButtons(time);
  }

  play(): boolean {
    const player = this.getPlayer();
    if (!player) return false; // the <video> is fine for this
    try {
      player.play()?.catch?.(() => undefined);
      return true;
    } catch {
      this.player = undefined;
      return false;
    }
  }

  pause(): boolean {
    const player = this.getPlayer();
    if (!player) return false;
    try {
      player.pause();
      return true;
    } catch {
      this.player = undefined;
      return false;
    }
  }

  // Restart a stuck player the way a viewer would. Only when Crunchyroll's
  // button shows "play": otherwise the click would pause it.
  clickPlay(): boolean {
    const button = document.querySelector<HTMLButtonElement>(SELECTORS.playPause);
    if (!button || !button.querySelector(SELECTORS.playIcon)) return false;
    button.click();
    return true;
  }

  // ---------------------------------------------------------------- jumps with buttons

  private seekWithButtons(time: number): number | false {
    const forward = document.querySelector<HTMLButtonElement>(SELECTORS.forward);
    const backward = document.querySelector<HTMLButtonElement>(SELECTORS.backward);
    if (!forward || !backward) return false;

    if (this.clickTimer) clearTimeout(this.clickTimer);
    const delta = time - this.video.currentTime;
    const clicks = Math.min(MAX_CLICKS, Math.round(Math.abs(delta) / JUMP_SECONDS));
    if (clicks === 0) return 0; // a few seconds: caught up by speed adjustment
    const button = delta > 0 ? forward : backward;
    this.log("[driver] jumping with Crunchyroll's buttons", { clicks, direction: delta > 0 ? "+" : "-" });

    let done = 0;
    const clickNext = () => {
      this.clickTimer = undefined;
      if (!button.isConnected) return;
      button.click();
      done++;
      if (done < clicks) this.clickTimer = setTimeout(clickNext, CLICK_INTERVAL_MS);
    };
    clickNext();
    return clicks * CLICK_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- finding the player

  private getPlayer(): Any {
    if (this.player) {
      if (this.matchesVideo(this.player)) return this.player;
      this.player = undefined;
    }
    const now = performance.now();
    if (now - this.lastSearchAt < SEARCH_RETRY_MS) return undefined;
    this.lastSearchAt = now;

    const found = this.searchReactTree();
    if (found && this.matchesVideo(found)) {
      this.player = found;
      this.log("[driver] Crunchyroll player found, using it for jumps");
    } else if (!this.reported) {
      this.reported = true;
      this.log("[driver] Crunchyroll player not found, using its 10 s buttons for jumps");
      this.describeTree();
    }
    return this.player;
  }

  private matchesVideo(player: Any): boolean {
    try {
      return Math.abs(player.getCurrentTime() - this.video.currentTime) < 3;
    } catch {
      return false;
    }
  }

  private checkValue(value: Any, depth: number): Any {
    if (!value || typeof value !== "object") return undefined;
    if (isBitmovinPlayer(value)) return value;
    if (depth <= 0) return undefined;
    for (const key of keysOf(value, 40)) {
      let child: Any;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (isBitmovinPlayer(child)) return child;
      if (child && typeof child === "object" && depth > 1) {
        const nested = this.checkValue(child, depth - 1);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  private fiberOf(element: Element | null): Any {
    for (let level = 0; element && level < 30; level++, element = element.parentElement) {
      const node = pageObject(element) as Any;
      const key = keysOf(node, 200).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (key) return node[key];
    }
    return undefined;
  }

  private startPoints(): Element[] {
    const points: Element[] = [];
    for (const selector of [SELECTORS.playPause, SELECTORS.forward, SELECTORS.timeline]) {
      const element = document.querySelector(selector);
      if (element) points.push(element);
    }
    points.push(this.video);
    return points;
  }

  private searchReactTree(): Any {
    // The controls call the player: walk up from them through props, hooks,
    // class instances and contexts
    for (const start of this.startPoints()) {
      let fiber = this.fiberOf(start);
      for (let step = 0; fiber && step < 150; step++, fiber = fiber.return) {
        try {
          const fromProps = this.checkValue(fiber.memoizedProps, 2);
          if (fromProps) return fromProps;
          if (fiber.stateNode && typeof fiber.stateNode.nodeType !== "number") {
            const fromInstance = this.checkValue(fiber.stateNode, 2);
            if (fromInstance) return fromInstance;
          }
          let hook = fiber.memoizedState;
          for (let i = 0; hook && typeof hook === "object" && i < 80; i++, hook = hook.next) {
            const fromHook = this.checkValue(hook.memoizedState, 3);
            if (fromHook) return fromHook;
          }
          let context = fiber.dependencies?.firstContext;
          for (let i = 0; context && i < 40; i++, context = context.next) {
            const fromContext = this.checkValue(context.memoizedValue, 3);
            if (fromContext) return fromContext;
          }
        } catch {
          // keep walking
        }
      }
    }
    return undefined;
  }

  // Debug builds: describe the React components around the controls, to find
  // where Crunchyroll keeps its player in a future version
  private describeTree(): void {
    const start = document.querySelector(SELECTORS.playPause);
    let fiber = this.fiberOf(start);
    if (!fiber) {
      this.log("[driver] no React tree found on the controls");
      return;
    }
    const lines: string[] = [];
    for (let step = 0; fiber && step < 40; step++, fiber = fiber.return) {
      try {
        const type = fiber.type;
        const name = typeof type === "string" ? type : type?.displayName || type?.name || typeof type;
        const props = keysOf(fiber.memoizedProps, 8).join(",");
        const contexts: string[] = [];
        let context = fiber.dependencies?.firstContext;
        for (let i = 0; context && i < 5; i++, context = context.next) {
          contexts.push(keysOf(context.memoizedValue, 6).join(","));
        }
        lines.push(`${step}:${name}(${props})${contexts.length ? ` ctx[${contexts.join(" | ")}]` : ""}`);
      } catch {
        lines.push(`${step}:?`);
      }
    }
    this.log("[driver] tree", lines.join(" ; "));
  }
}
