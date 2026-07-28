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

// True when the app is loaded as a BridgeThing package (file:// or explicit flag),
// not when served by the bridge server itself.
export function isBridgeThingRuntime(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("transport") === "bridgething") return true;
  // Bridge server runs on port 4173 — exclude that case
  if (window.location.port === "4173" || window.location.port === "5173")
    return false;
  return (
    window.location.protocol === "file:" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost"
  );
}

// Read the bridge URL from BridgeThing's config store (on-device deployments).
export async function getWsUrlFromBridgeThing(): Promise<string | null> {
  try {
    const { BridgethingClient } = await import("@bridgething/client");
    const client = new BridgethingClient();
    try {
      const result = await client.config.list({ timeoutMs: 3000 });
      if (!result.ok) return null;
      const entry = result.response.entries.find((e) => e.key === "bridgeUrl");
      return entry?.value?.trim() || null;
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}

// Read brightness settings from BridgeThing and apply to the display.
export async function applyBridgeThingBrightness(): Promise<void> {
  try {
    const { BridgethingClient } = await import("@bridgething/client");
    const client = new BridgethingClient();
    try {
      const [docResult] = await Promise.all([
        client.doc.list({ timeoutMs: 3000 }),
      ]);
      if (!docResult.ok) return;
      const docs = Object.fromEntries(
        docResult.response.entries.map((e) => [e.key, e.value]),
      );
      const mode = docs.brightnessMode === "manual" ? "manual" : "auto";
      const level = Math.max(
        0.05,
        Math.min(1, Number(docs.brightnessLevel ?? "0.55")),
      );
      await client.hardware.displaySetMode({ mode });
      if (mode === "manual") await client.hardware.displaySetLevel({ level });
    } finally {
      client.close();
    }
  } catch {
    // Not fatal — brightness just stays at current level
  }
}

// ── Enhanced Config Fallback ─────────────────────────────────────

/** Load config from local device-config.json file */
export async function tryLoadDeviceConfig(): Promise<string | null> {
  try {
    const response = await fetch("./device-config.json", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return data.bridgeUrl?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Discover config URLs from various sources */
export async function discoverConfigUrls(): Promise<string | null> {
  // Try local config file first
  const localConfig = await tryLoadDeviceConfig();
  if (localConfig) return localConfig;

  // Try companion app proxy endpoint
  try {
    const response = await fetch("http://172.16.42.1:4173/api/device-config", {
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json();
      return data.bridgeUrl?.trim() ?? null;
    }
  } catch {
    // Ignore - continue to next fallback
  }

  // No fallback found
  return null;
}

/** Discover bridge URL on local network */
export async function discoverBridgeUrl(): Promise<string | null> {
  const candidates = [
    "ws://10.0.0.100:4173/ws",
    "ws://192.168.1.100:4173/ws",
    "ws://192.168.0.100:4173/ws",
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost"
      ? "ws://host.docker.internal:4173/ws" // Docker case
      : null,
  ].filter((url): url is string => !!url);

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000); // 1 second timeout

      const response = await fetch(
        url.replace("ws://", "http://") + "/api/status",
        {
          signal: controller.signal,
          headers: { "Cache-Control": "no-store" },
        },
      );

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        // Verify it's actually our bridge
        if (data.ok && data.player !== null) {
          saveBridgeUrl(url); // Cache for future use
          return url;
        }
      }
    } catch {
      // Ignore - try next candidate
    }
  }

  return null;
}

// Synchronous URL resolution when served from the bridge server.
export function getWsUrlFromOrigin(): string | null {
  if (window.location.host && window.location.protocol !== "file:") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return null;
}

export function saveBridgeUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url);
}

export function getSavedBridgeUrl(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
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
      try {
        fn(value);
      } catch {
        /* ignore listener errors */
      }
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
