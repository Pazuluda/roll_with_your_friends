import { log } from "./common";
import { SyncController } from "./sync";
import { CrunchyrollDriver } from "./crunchyroll_driver";
import { Message, MessageTypes, PortName } from "./types";
import { extensionAPI } from "./browser-compat";

// Crunchyroll players: the old one ("player0") and the Bitmovin one
// ("bitmovinplayer-video-<container id>", currently "bitmovinplayer-video-null").
const KNOWN_PLAYER_SELECTORS = ["#player0", 'video[id^="bitmovinplayer-video"]'];
const PLAYER_POLL_MS = 500;
const HEART_BEAT_MS = 20000; // Keeps the Chrome service worker alive while connected

let g_port: chrome.runtime.Port | undefined = undefined;
let g_video: HTMLVideoElement | undefined = undefined;
let g_heartBeatInterval: ReturnType<typeof setInterval> | undefined = undefined;
let g_overlay: HTMLButtonElement | undefined = undefined;

const sync = new SyncController(
  {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  {
    send: (state, currentProgress) => {
      g_port?.postMessage({
        type: MessageTypes.CS2SW_LOCAL_UPDATE,
        state,
        currentProgress,
      });
    },
    onAutoplayBlocked: (blocked) => (blocked ? showJoinButton() : hideJoinButton()),
    log: (...args) => log("[sync]", ...args),
  }
);

// ------------------------------------------------------------------ player

function isVideo(element: Element | null): element is HTMLVideoElement {
  return !!element && element.tagName === "VIDEO";
}

function findVideo(): HTMLVideoElement | undefined {
  for (const selector of KNOWN_PLAYER_SELECTORS) {
    const element = document.querySelector(selector);
    if (isVideo(element)) return element;
  }

  // Fallback if Crunchyroll renames its player again: the biggest video on the page
  let best: HTMLVideoElement | undefined = undefined;
  let bestArea = 0;
  for (const video of Array.from(document.querySelectorAll("video"))) {
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}

function watchForPlayer(): void {
  const video = findVideo();
  if (video && video !== g_video) {
    log("Player found", video.id);
    g_video = video;
    sync.setDriver(new CrunchyrollDriver(video, (...args) => log(...args)));
    sync.attach(video);
    probePlayer(video);
    // Only the frame that actually holds the player talks to the background
    // script, otherwise other Crunchyroll frames could steal the connection.
    connectPort();
  }
  setTimeout(watchForPlayer, PLAYER_POLL_MS);
}

// Debug builds only: describe Crunchyroll's player controls, to be able to drive
// them directly in a future version (logs nothing in normal builds)
function probePlayer(video: HTMLVideoElement): void {
  setTimeout(() => {
    const controls = Array.from(document.querySelectorAll("[data-testid], button[aria-label], [role=slider]"))
      .slice(0, 80)
      .map((el) => {
        const testId = el.getAttribute("data-testid");
        const label = el.getAttribute("aria-label");
        return `${el.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ""}${label ? ` "${label}"` : ""}`;
      });
    log("[probe] player controls", controls.join(" | "));
    log("[probe] video", { id: video.id, src: video.currentSrc.slice(0, 40), parent: video.parentElement?.className });
  }, 5000);
}

// ------------------------------------------------------------------ background script

function connectPort(): void {
  if (g_port) return;
  g_port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });
  g_port.onMessage.addListener(handleServiceWorkerMessage);
  g_port.onDisconnect.addListener(() => {
    // Extension reloaded or updated: this page is no longer connected
    log("Port disconnected");
    g_port = undefined;
    stopHeartBeat();
    sync.leaveRoom();
  });
}

function startHeartBeat(): void {
  if (g_heartBeatInterval) return;
  g_heartBeatInterval = setInterval(
    () => g_port?.postMessage({ type: MessageTypes.CS2SW_HEART_BEAT }),
    HEART_BEAT_MS
  );
}

function stopHeartBeat(): void {
  if (g_heartBeatInterval) clearInterval(g_heartBeatInterval);
  g_heartBeatInterval = undefined;
}

function handleServiceWorkerMessage(message: Message): void {
  log("Received message from Background", message);

  switch (message.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION: {
      const { state, progress } = sync.snapshot();
      g_port?.postMessage({
        type: MessageTypes.CS2SW_ROOM_CONNECTION,
        state,
        currentProgress: progress,
      });
      break;
    }
    case MessageTypes.SW2CS_REMOTE_UPDATE:
      startHeartBeat();
      sync.handleRemote({
        kind: message.kind,
        rejoin: message.rejoin,
        state: message.roomState,
        progress: message.roomProgress,
        userCount: message.userCount,
        senderId: message.senderId,
      });
      break;
    case MessageTypes.SW2CS_ROOM_DISCONNECT:
      stopHeartBeat();
      sync.leaveRoom();
      break;
    default:
      log("Ignoring unknown message", message);
  }
}

// ------------------------------------------------------------------ "join playback" button
// Firefox refuses to start a video with sound until the user has clicked on the
// page. When that happens we show a button: one click and the video joins the room.

function showJoinButton(): void {
  if (g_overlay) return;
  const button = document.createElement("button");
  button.textContent = navigator.language.toLowerCase().startsWith("fr")
    ? "▶ Roll With Your Friends : clique ici pour rejoindre la lecture"
    : "▶ Roll With Your Friends: click here to join the playback";
  Object.assign(button.style, {
    position: "fixed",
    left: "50%",
    bottom: "18%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    padding: "14px 22px",
    font: "600 16px/1.2 system-ui, sans-serif",
    color: "#ffffff",
    background: "#F78C25",
    border: "none",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.45)",
    cursor: "pointer",
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideJoinButton();
    sync.resumeFromUserGesture();
  });
  g_overlay = button;
  placeJoinButton();
}

function placeJoinButton(): void {
  if (!g_overlay) return;
  // In fullscreen only the fullscreen element is visible
  (document.fullscreenElement ?? document.body).appendChild(g_overlay);
}

function hideJoinButton(): void {
  g_overlay?.remove();
  g_overlay = undefined;
}

document.addEventListener("fullscreenchange", placeJoinButton);

watchForPlayer();
