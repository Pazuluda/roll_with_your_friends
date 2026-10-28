// Drives Crunchyroll's own player instead of the raw <video> element.
//
// Crunchyroll plays videos with Bitmovin, which loads the video piece by piece
// itself. Setting video.currentTime directly bypasses it: it does not load the
// new position and the image freezes ("AbortError" on play). Going through the
// player keeps it in charge.
//
// 1. Best: the Bitmovin player object (seek/play/pause), found in the page's
//    React tree. Firefox lets extensions read page objects (wrappedJSObject).
// 2. Otherwise for play/pause: Crunchyroll's play/pause button.
// 3. Otherwise: the <video> element (methods return false).

import { PlayerDriver } from "./sync";

type Log = (...args: unknown[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SEARCH_RETRY_MS = 3000;
const PLAY_PAUSE_BUTTON = '[data-testid="play-pause-button"]';

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
      typeof candidate.getCurrentTime === "function" &&
      typeof candidate.isPlaying === "function"
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

  constructor(private video: HTMLVideoElement, private log: Log) {}

  seek(time: number): boolean {
    const player = this.getPlayer();
    if (!player) return false;
    try {
      player.seek(time);
      return true;
    } catch (error) {
      this.log("[driver] seek failed", error);
      this.player = undefined;
      return false;
    }
  }

  play(): boolean {
    const player = this.getPlayer();
    if (player) {
      try {
        const result = player.play();
        result?.catch?.(() => undefined);
        return true;
      } catch (error) {
        this.log("[driver] play failed", error);
        this.player = undefined;
      }
    }
    // Without the player object, starting goes through the <video>: that is
    // how we learn that the browser blocks autoplay (a button click would fail
    // silently). The button is only used to unblock a frozen player.
    return false;
  }

  // Start a frozen player the way a viewer would
  clickPlay(): boolean {
    return this.video.paused ? this.clickPlayPause() : true;
  }

  pause(): boolean {
    const player = this.getPlayer();
    if (player) {
      try {
        player.pause();
        return true;
      } catch (error) {
        this.log("[driver] pause failed", error);
        this.player = undefined;
      }
    }
    return this.video.paused ? true : this.clickPlayPause();
  }

  // ---------------------------------------------------------------- internals

  private clickPlayPause(): boolean {
    const button = document.querySelector<HTMLButtonElement>(PLAY_PAUSE_BUTTON);
    if (!button) return false;
    button.click();
    return true;
  }

  private getPlayer(): Any {
    if (this.player) {
      try {
        // Still the player of our video? (Crunchyroll rebuilds it between episodes)
        if (Math.abs(this.player.getCurrentTime() - this.video.currentTime) < 3) return this.player;
      } catch {
        // gone
      }
      this.player = undefined;
    }
    const now = performance.now();
    if (now - this.lastSearchAt < SEARCH_RETRY_MS) return undefined;
    this.lastSearchAt = now;

    const found = this.searchReactTree() ?? this.searchGlobals();
    if (found && this.matchesVideo(found)) {
      this.player = found;
      this.log("[driver] Crunchyroll player found, using it for play/pause/seek");
    } else if (!this.reported) {
      this.reported = true;
      this.log("[driver] Crunchyroll player not found, using its play/pause button");
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
      // refs: { current: player }
      if (child && typeof child === "object" && depth > 1) {
        const nested = this.checkValue(child, depth - 1);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  private searchReactTree(): Any {
    // Find the React fiber of an element around the video, then walk up
    let element: Element | null = this.video;
    for (let level = 0; element && level < 25; level++, element = element.parentElement) {
      const node = pageObject(element) as Any;
      const fiberKey = keysOf(node, 200).find(
        (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
      );
      if (!fiberKey) continue;

      let fiber = node[fiberKey];
      for (let step = 0; fiber && step < 120; step++, fiber = fiber.return) {
        try {
          const fromProps = this.checkValue(fiber.memoizedProps, 2);
          if (fromProps) return fromProps;
          if (fiber.stateNode && typeof fiber.stateNode.nodeType !== "number") {
            const fromInstance = this.checkValue(fiber.stateNode, 2);
            if (fromInstance) return fromInstance;
          }
          // hooks: useState / useRef / useMemo values
          let hook = fiber.memoizedState;
          for (let i = 0; hook && typeof hook === "object" && i < 60; i++, hook = hook.next) {
            const fromHook = this.checkValue(hook.memoizedState, 2);
            if (fromHook) return fromHook;
          }
          // useContext values
          let context = fiber.dependencies?.firstContext;
          for (let i = 0; context && i < 30; i++, context = context.next) {
            const fromContext = this.checkValue(context.memoizedValue, 2);
            if (fromContext) return fromContext;
          }
        } catch {
          // keep walking
        }
      }
      return undefined;
    }
    return undefined;
  }

  private searchGlobals(): Any {
    const win = pageObject(window) as Any;
    for (const key of keysOf(win, 1500)) {
      try {
        const found = this.checkValue(win[key], 1);
        if (found) return found;
      } catch {
        // ignore
      }
    }
    return undefined;
  }
}
