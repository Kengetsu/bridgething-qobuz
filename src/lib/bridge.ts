import type {
  BridgeFullState,
  ClientMessage,
  PlaybackState,
  ServerMessage,
  TrackInfo,
} from "../types";

const RECONNECT_DELAY_MS = 3000;
const STORAGE_KEY = "qobuz_carthing_bridge_url";

function defaultPlayback(): PlaybackState {
  return {
    status: "Stopped",
    position: 0,
    volume: 1,
    shuffle: false,
    loop: "None",
    timestamp: Date.now(),
  };
}

function defaultState(): BridgeFullState {
  return { playerName: null, track: null, playback: defaultPlayback() };
}

export function getWsUrl(): string {
  // When served from the bridge server, derive WebSocket URL from page origin
  if (window.location.host && window.location.protocol !== "file:") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  // Device deployment: read from localStorage, fall back to a prompt
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

export function saveBridgeUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url);
}

type Listener<T> = (value: T) => void;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _state: BridgeFullState = defaultState();
  private destroyed = false;

  private stateListeners = new Set<Listener<BridgeFullState>>();
  private trackListeners = new Set<Listener<TrackInfo | null>>();
  private playbackListeners = new Set<Listener<PlaybackState>>();
  private connectListeners = new Set<Listener<boolean>>();

  public connected = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private connect() {
    if (this.destroyed || !this.url) return;

    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this.emit(this.connectListeners, true);
      });

      ws.addEventListener("close", () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.ws = null;
        this.emit(this.connectListeners, false);
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // close will fire after error
      });

      ws.addEventListener("message", (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as ServerMessage;
          this.handleMessage(msg);
        } catch {
          // ignore malformed messages
        }
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "hello":
        this._state = msg.state;
        this.emit(this.trackListeners, this._state.track);
        this.emit(this.playbackListeners, this._state.playback);
        this.emit(this.stateListeners, this._state);
        break;
      case "track":
        this._state = { ...this._state, track: msg.track };
        this.emit(this.trackListeners, msg.track);
        this.emit(this.stateListeners, this._state);
        break;
      case "playback":
        this._state = { ...this._state, playback: msg.playback };
        this.emit(this.playbackListeners, msg.playback);
        this.emit(this.stateListeners, this._state);
        break;
      case "player":
        this._state = { ...this._state, playerName: msg.playerName };
        this.emit(this.stateListeners, this._state);
        break;
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T) {
    for (const fn of listeners) {
      try { fn(value); } catch { /* ignore listener errors */ }
    }
  }

  get state(): BridgeFullState {
    return this._state;
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onState(fn: Listener<BridgeFullState>): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  onTrack(fn: Listener<TrackInfo | null>): () => void {
    this.trackListeners.add(fn);
    return () => this.trackListeners.delete(fn);
  }
  onPlayback(fn: Listener<PlaybackState>): () => void {
    this.playbackListeners.add(fn);
    return () => this.playbackListeners.delete(fn);
  }
  onConnect(fn: Listener<boolean>): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  close() {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
