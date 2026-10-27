import io from "socket.io-client";
import _ from "lodash";

import { log, getParameterByName, setIconColor } from "./common";
import { Message, MessageTypes, PortName, States, TabInfo } from "./types";
import { extensionAPI, getActionAPI } from "./browser-compat";

declare const process: { env: { [key: string]: string | undefined } };
declare const self: ServiceWorkerGlobalScope;

const tabsInfo: { [index: number]: TabInfo | undefined } = {};
const serverUrl = process.env.SYNC_SERVER!;
const pendingDisconnects: { [index: number]: ReturnType<typeof setTimeout> | undefined } = {};
// How long a tab keeps its room while its page reloads (the new page only
// reconnects once the Crunchyroll player exists, which can take a few seconds)
const RELOAD_GRACE_MS = 15000;

let popupPort: chrome.runtime.Port | undefined = undefined;

function postToTab(tabInfo: TabInfo | undefined, message: Message): void {
  if (!tabInfo) return;
  try {
    tabInfo.port.postMessage(message);
  } catch (error) {
    // The page is gone or reloading, it will be updated when it reconnects
    log("Could not reach content script", tabInfo.tabId, error);
  }
}

function currentRoomProgress(tabInfo: TabInfo): number {
  const room = tabInfo.room!;
  const elapsed = room.state === States.PLAYING ? (Date.now() - room.at) / 1000 : 0;
  return room.progress + elapsed;
}

function handleContentScriptConnection(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  const url = port.sender?.tab?.url;
  if (tabId === undefined) return;

  if (pendingDisconnects[tabId]) {
    clearTimeout(pendingDisconnects[tabId]);
    delete pendingDisconnects[tabId];
  }

  const existingInfo = tabsInfo[tabId];
  if (existingInfo && existingInfo.socket) {
    // The page was reloaded while in a room: keep the room and bring the new page up to date
    existingInfo.port = port;
    existingInfo.sentConnectionRequest = false;
    getActionAPI().enable(tabId);
    if (existingInfo.roomId && existingInfo.room) {
      postToTab(existingInfo, {
        type: MessageTypes.SW2CS_REMOTE_UPDATE,
        kind: "join",
        roomState: existingInfo.room.state,
        roomProgress: currentRoomProgress(existingInfo),
        userCount: existingInfo.room.userCount,
      });
    }
    // Otherwise the socket is still joining: the "join" will reach this new page
    return;
  }

  tabsInfo[tabId] = { port, tabId, sentConnectionRequest: false };

  const urlRoomId: string | null = url ? getParameterByName(url, "rollTogetherRoom") : null;
  if (!_.isNil(urlRoomId)) {
    sendConnectionRequestToContentScript(tabId);
  } else {
    getActionAPI().enable(tabId);
  }
}

function handleContentScriptDisconnection(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;

  // Delay cleanup to allow a reconnect (page reload) to cancel it
  pendingDisconnects[tabId] = setTimeout(() => {
    delete pendingDisconnects[tabId];
    const tabInfo = tabsInfo[tabId];

    // If the port was already replaced by a new connection, skip cleanup
    if (tabInfo && tabInfo.port !== port) {
      log("Ignoring stale port disconnect for tab", tabId);
      return;
    }

    getActionAPI().disable(tabId);
    cleanupTab(tabId);
  }, RELOAD_GRACE_MS);
}

function cleanupTab(tabId: number): void {
  disconnectWebsocket(tabId);
  delete tabsInfo[tabId];
}

function tryUpdatePopup(roomId: string | undefined = undefined): void {
  log("Trying to update popup", roomId);
  popupPort?.postMessage({
    type: MessageTypes.SW2PU_SEND_ROOM_ID,
    roomId: roomId,
  });
}

function disconnectWebsocket(tabId: number): void {
  log("Disconnecting websocket", tabId);
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  const { socket }: TabInfo = tabInfo;
  if (socket) {
    socket.disconnect();
    delete tabInfo.socket;
  }
  delete tabInfo.roomId;
  delete tabInfo.room;
  tabInfo.sentConnectionRequest = false;

  // Tell the page it is no longer in a room (stops its sync corrections)
  postToTab(tabInfo, { type: MessageTypes.SW2CS_ROOM_DISCONNECT });
  tryUpdatePopup();
}

function handlePopupMessage(message: Message, port: chrome.runtime.Port): void {
  switch (message.type) {
    case MessageTypes.PU2SW_CREATE_ROOM:
      sendConnectionRequestToContentScript(message.tabId);
      break;
    case MessageTypes.PU2SW_DISCONNECT_ROOM:
      disconnectWebsocket(message.tabId);
      break;
    case MessageTypes.PU2SW_REQUEST_ROOM_ID:
      tryUpdatePopup(tabsInfo[message.tabId]?.roomId);
      break;
    default:
      throw "Invalid PopupMessageType " + message.type;
  }
}

function handleContentScriptMessage(
  message: Message,
  port: chrome.runtime.Port
): void {
  const senderUrl = port.sender?.tab?.url ?? "";
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;
  log("Received message from contentScript", { tabId, message });

  switch (message.type) {
    case MessageTypes.CS2SW_HEART_BEAT:
      break;
    case MessageTypes.CS2SW_ROOM_CONNECTION:
      connectWebsocket(
        tabId,
        message.currentProgress,
        message.state,
        getParameterByName(senderUrl)
      );
      break;
    case MessageTypes.CS2SW_LOCAL_UPDATE: {
      const tabInfo = tabsInfo[tabId];
      if (!tabInfo?.socket) break;
      tabInfo.socket.emit("update", message.state, message.currentProgress);
      tabInfo.room = {
        state: message.state,
        progress: message.currentProgress,
        userCount: tabInfo.room?.userCount ?? 1,
        at: Date.now(),
      };
      break;
    }
    default:
      throw "Invalid ContentScriptMessageType " + message.type;
  }
}

function sendUpdateToContentScript(
  tabId: number,
  kind: "join" | "update",
  roomState: States,
  roomProgress: number,
  userCount: number,
  rejoin: boolean = false,
  senderId: string | undefined = undefined
): void {
  log("Sending update to contentScript", { tabId, kind, roomState, roomProgress, userCount, rejoin, senderId });

  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) return;
  tabInfo.room = { state: roomState, progress: roomProgress, userCount, at: Date.now() };

  postToTab(tabInfo, {
    type: MessageTypes.SW2CS_REMOTE_UPDATE,
    kind,
    rejoin,
    roomState,
    roomProgress,
    userCount,
    senderId,
  });
}

function sendConnectionRequestToContentScript(tabId: number): void {
  const tabInfo = tabsInfo[tabId];
  log({ tabsInfo, tabInfo, tabId });

  if (tabInfo == undefined) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }
  const tab = tabInfo.port.sender?.tab;

  if (tabInfo.sentConnectionRequest) {
    log("Connection request already sent to contentScript", { tab });
    return;
  }

  if (tabInfo.socket) {
    if (tab?.url && getParameterByName(tab.url, "rollTogetherRoom") === tabInfo.roomId) {
      return;
    }
    disconnectWebsocket(tabId);
  }
  tabInfo.sentConnectionRequest = true;

  log("Sending connection request to contentScript", { tab });

  postToTab(tabInfo, { type: MessageTypes.SW2CS_ROOM_CONNECTION });
}

function connectWebsocket(
  tabId: number,
  videoProgress: number,
  videoState: States,
  urlRoomId: string | null
) {
  log("Connecting websocket", {
    tabId,
    videoProgress,
    videoState,
    urlRoomId,
  });
  const tabInfo = tabsInfo[tabId];
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  if (tabInfo.socket) {
    log(
      `Socket is already configured for tab ${tabId}. Disconnect existing connection before attempting to connect.`
    );
    return;
  }

  const query: { [key: string]: string } = {
    videoProgress: `${Math.round(videoProgress)}`,
    videoState,
  };
  if (urlRoomId) query.room = urlRoomId;

  const socket = io(serverUrl, { query, transports: ["websocket"] });
  tabInfo.socket = socket;

  // socket.io reconnects by itself after a network hiccup. Without this, the
  // room creator (whose URL has no room id) was put alone in a brand new room.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager = (socket as any).io;
  manager?.on?.("reconnect_attempt", () => {
    if (!tabInfo.roomId) return;
    const progress = tabInfo.room ? currentRoomProgress(tabInfo) : videoProgress;
    manager.opts.query = {
      ...query,
      room: tabInfo.roomId,
      videoProgress: `${Math.round(progress)}`,
    };
    log("Reconnecting to room", tabInfo.roomId);
  });

  socket.on(
    "join",
    (
      receivedRoomId: string,
      roomState: States,
      roomProgress: number,
      userCount: number = 1
    ): void => {
      if (tabsInfo[tabId] !== tabInfo || tabInfo.socket !== socket) return;
      const rejoin = tabInfo.roomId === receivedRoomId;
      tabInfo.roomId = receivedRoomId;
      log("Sucessfully joined a room", {
        roomId: tabInfo.roomId,
        roomState,
        roomProgress,
        userCount,
        rejoin,
      });
      tryUpdatePopup(tabInfo.roomId);
      getActionAPI().enable(tabId);
      tabInfo.sentConnectionRequest = false;

      sendUpdateToContentScript(tabId, "join", roomState, roomProgress, userCount, rejoin);
    }
  );

  socket.on(
    "update",
    (id: string, roomState: States, roomProgress: number, userCount: number = 0): void => {
      if (tabsInfo[tabId] !== tabInfo || tabInfo.socket !== socket) return;
      log("Received update Message from ", id, { roomState, roomProgress, userCount });
      sendUpdateToContentScript(tabId, "update", roomState, roomProgress, userCount, false, id);
    }
  );
}

extensionAPI.runtime.onConnect.addListener(function (port: chrome.runtime.Port) {
  log("Port connected", port.name);
  switch (port.name) {
    case PortName.POPUP:
      popupPort = port;
      log("Popup connected");

      port.onDisconnect.addListener(() => {
        popupPort = undefined;
        log("Popup disconnected");
      });
      port.onMessage.addListener(handlePopupMessage);
      break;
    case PortName.CONTENT_SCRIPT:
      handleContentScriptConnection(port);
      log(`${port.name} connected`, port.sender?.tab?.id);

      port.onDisconnect.addListener(() => {
        handleContentScriptDisconnection(port);
        log(`${port.name} disconnected`, port.sender?.tab?.id);
      });

      port.onMessage.addListener(handleContentScriptMessage);
      break;
    default:
      throw "Invalid PortName " + port.name;
  }
});

// Closing the tab leaves the room right away (no need to wait for a reload)
extensionAPI.tabs.onRemoved.addListener((tabId: number) => {
  if (pendingDisconnects[tabId]) {
    clearTimeout(pendingDisconnects[tabId]);
    delete pendingDisconnects[tabId];
  }
  if (tabsInfo[tabId]) cleanupTab(tabId);
});

extensionAPI.runtime.onInstalled.addListener(() => {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext("2d")! as OffscreenCanvasRenderingContext2D;
  setIconColor(canvas, ctx);
});

getActionAPI().disable();
self.addEventListener = _.noop;

log("Service Worker Loaded");
