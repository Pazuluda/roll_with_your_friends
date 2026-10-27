export enum Actions {
  PLAY = "play",
  PAUSE = "pause",
  READY = "ready",
  ENDED = "ended",
  TIME_UPDATE = "timeupdate",
}
export type PlayerStateProp =
  | "controls"
  | "currentTime"
  | "defaultMuted"
  | "defaultPlaybackRate"
  | "duration"
  | "ended"
  | "loop"
  | "muted"
  | "paused"
  | "playbackRate"
  | "volume";

export enum States {
  PLAYING = "playing",
  PAUSED = "paused",
}

// Service Worker => SW
// Content Script => CS
// Popup => PU
export enum MessageTypes {
  PORT_CONNECTION = "port_connection",
  SW2CS_REMOTE_UPDATE = "sw2cs_remote_update",
  SW2CS_ROOM_CONNECTION = "sw2cs_room_connection",
  SW2CS_ROOM_DISCONNECT = "sw2cs_room_disconnect",
  SW2PU_SEND_ROOM_ID = "sw2pu_update_ux",
  SW2PU_ROOM_ID = "sw2pu_room_id",
  PU2SW_REQUEST_ROOM_ID = "pu2sw_get_room_id",
  PU2SW_CREATE_ROOM = "pu2sw_create_room",
  PU2SW_DISCONNECT_ROOM = "pu2sw_disconnect_room",
  CS2SW_LOCAL_UPDATE = "cs2w2_local_update",
  CS2SW_ROOM_CONNECTION = "cs2w2_room_connection",
  CS2SW_HEART_BEAT = "cs2w2_heart_beat",
}

export enum PortName {
  CONTENT_SCRIPT = "content_script",
  POPUP = "popup",
}

export interface Ports {
  [PortName.CONTENT_SCRIPT]: chrome.runtime.Port | undefined;
  [PortName.POPUP]: chrome.runtime.Port | undefined;
}

export type Message =
  | { type: MessageTypes.PORT_CONNECTION; name: PortName }
  | {
      type: MessageTypes.SW2CS_REMOTE_UPDATE;
      // "join": this tab (re)entered the room, "update": the room changed
      kind: "join" | "update";
      // join caused by a reconnection while the page was already in the room
      rejoin?: boolean;
      roomState: States;
      roomProgress: number;
      userCount: number;
      // socket id of the friend at the origin of an update
      senderId?: string;
    }
  | { type: MessageTypes.SW2CS_ROOM_CONNECTION }
  | { type: MessageTypes.SW2PU_SEND_ROOM_ID; roomId: string }
  | { type: MessageTypes.SW2PU_ROOM_ID; roomId: string }
  | { type: MessageTypes.PU2SW_CREATE_ROOM; tabId: number }
  | { type: MessageTypes.PU2SW_REQUEST_ROOM_ID; tabId: number }
  | { type: MessageTypes.PU2SW_DISCONNECT_ROOM; tabId: number }
  | {
      type: MessageTypes.CS2SW_LOCAL_UPDATE;
      state: States;
      currentProgress: number;
    }
  | {
      type: MessageTypes.CS2SW_ROOM_CONNECTION;
      state: States;
      currentProgress: number;
    }
  | { type: MessageTypes.CS2SW_HEART_BEAT }
  | { type: MessageTypes.SW2CS_ROOM_DISCONNECT };

export interface StorageData {
  extensionColor?: string;
  colorOptions?: string[];
}

export interface RoomStatus {
  state: States;
  progress: number;
  userCount: number;
  at: number; // Date.now() when this status was known
}

export interface TabInfo {
  tabId: number;
  port: chrome.runtime.Port;
  socket?: SocketIOClient.Socket;
  roomId?: string;
  // Last known room status, used to bring a reloaded page back in sync
  room?: RoomStatus;
  sentConnectionRequest: boolean;
}

export interface Radius {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}
