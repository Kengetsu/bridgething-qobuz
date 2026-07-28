import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";
import {
  BridgeClient,
  applyBridgeThingBrightness,
  getSavedBridgeUrl,
  getWsUrlFromBridgeThing,
  getWsUrlFromOrigin,
  isBridgeThingRuntime,
  saveBridgeUrl,
} from "./lib/bridge";
import type { PlaybackState, TrackInfo } from "./types";

function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

function progressPct(pos: number, dur: number): number {
  if (!dur) return 0;
  return Math.min(100, (pos / dur) * 100);
}

// ── Settings screen shown when no bridge URL is configured ──────
function SettingsScreen({ onSave }: { onSave: (url: string) => void }) {
  const [value, setValue] = useState("ws://192.168.1.100:4173/ws");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = value.trim();
    if (url) {
      saveBridgeUrl(url);
      onSave(url);
    }
  };

  return (
    <div className="status-screen">
      <WifiOff size={48} />
      <h2>Connect to Bridge</h2>
      <p>Enter the WebSocket URL of the Qobuz bridge server running on your desktop.</p>
      <form className="settings-form" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="bridge-url">Bridge URL</label>
          <input
            id="bridge-url"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ws://192.168.1.x:4173/ws"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="btn-primary">Connect</button>
      </form>
    </div>
  );
}

// ── Main app ────────────────────────────────────────────────────
export default function App() {
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [displayPos, setDisplayPos] = useState(0);
  const [artError, setArtError] = useState(false);

  const clientRef = useRef<BridgeClient | null>(null);
  const posRef = useRef({ position: 0, timestamp: 0, playing: false });

  // Resolve bridge URL on mount — strategy depends on runtime context
  useEffect(() => {
    if (isBridgeThingRuntime()) {
      // Running as a BridgeThing package: read URL from config store
      applyBridgeThingBrightness();
      getWsUrlFromBridgeThing().then((url) => setWsUrl(url ?? null));
    } else {
      // Running from bridge server: WebSocket is at the same host
      setWsUrl(getWsUrlFromOrigin() ?? getSavedBridgeUrl() ?? null);
    }
  }, []);

  // Create/recreate bridge client when URL changes
  useEffect(() => {
    if (!wsUrl) return;

    const client = new BridgeClient(wsUrl);
    clientRef.current = client;

    const unsub = [
      client.onConnect(setConnected),
      client.onTrack((t) => {
        setTrack(t);
        setArtError(false);
      }),
      client.onPlayback((pb) => {
        setPlayback(pb);
        posRef.current = { position: pb.position, timestamp: pb.timestamp, playing: pb.status === "Playing" };
        setDisplayPos(pb.position);
      }),
    ];

    return () => {
      unsub.forEach((fn) => fn());
      client.close();
      clientRef.current = null;
    };
  }, [wsUrl]);

  // Interpolate position locally while track is playing
  useEffect(() => {
    if (playback?.status !== "Playing") return;
    const id = setInterval(() => {
      const { position, timestamp, playing } = posRef.current;
      if (!playing) return;
      const elapsed = (Date.now() - timestamp) / 1000;
      setDisplayPos(position + elapsed);
    }, 250);
    return () => clearInterval(id);
  }, [playback?.status]);

  const send = useCallback((type: string, extra?: Record<string, unknown>) => {
    clientRef.current?.send({ type, ...extra } as Parameters<BridgeClient["send"]>[0]);
  }, []);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!track?.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      send("seek", { position: ratio * track.duration });
    },
    [track?.duration, send]
  );

  const handleVolumeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const value = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      send("volume", { value });
    },
    [send]
  );

  // ── No URL configured ───────────────────────────────────────
  if (!wsUrl) {
    if (isBridgeThingRuntime()) {
      return (
        <div className="status-screen">
          <WifiOff size={48} />
          <h2>Not configured</h2>
          <p>Open the BridgeThing companion app and set the Bridge URL in Qobuz settings.</p>
        </div>
      );
    }
    return <SettingsScreen onSave={setWsUrl} />;
  }

  // ── Connecting ──────────────────────────────────────────────
  if (!connected) {
    return (
      <div className="status-screen">
        <Loader2 size={48} className="spin" />
        <h2>Connecting…</h2>
        <p>Waiting for the bridge server at {wsUrl}</p>
        <button
          className="btn-primary"
          style={{ marginTop: 8 }}
          onClick={() => { saveBridgeUrl(""); setWsUrl(null); }}
        >
          Change URL
        </button>
      </div>
    );
  }

  // ── Nothing playing ─────────────────────────────────────────
  if (!track || playback?.status === "Stopped") {
    return (
      <div className="status-screen">
        <Music2 size={64} />
        <h2>Nothing playing</h2>
        <p>Open QBZ on your desktop and start playing music</p>
      </div>
    );
  }

  // ── Now playing ─────────────────────────────────────────────
  const isPlaying = playback?.status === "Playing";
  const pos = Math.min(displayPos, track.duration || Infinity);
  const vol = playback?.volume ?? 1;

  return (
    <div className="now-playing">
      {/* Blurred background */}
      {track.artUrl && !artError && (
        <div className="art-bg">
          <img src={track.artUrl} alt="" aria-hidden />
        </div>
      )}

      {/* Album art */}
      <div className="art-panel">
        <div className="art-frame">
          {track.artUrl && !artError ? (
            <img
              src={track.artUrl}
              alt={`${track.album} cover`}
              onError={() => setArtError(true)}
            />
          ) : (
            <div className="art-placeholder">
              <Music2 size={64} />
            </div>
          )}
        </div>
      </div>

      {/* Info + controls */}
      <div className="info-panel">
        <div className="track-info">
          <div className="track-title" title={track.title}>{track.title}</div>
          <div className="track-artist" title={track.artist}>{track.artist}</div>
          {track.album && (
            <div className="track-album" title={track.album}>{track.album}</div>
          )}
        </div>

        {/* Progress */}
        <div className="progress-area">
          <div className="progress-times">
            <span>{formatTime(pos)}</span>
            <span>{track.duration > 0 ? formatTime(track.duration) : "–"}</span>
          </div>
          <div
            className="progress-track"
            onClick={handleProgressClick}
            role="slider"
            aria-label="Playback position"
            aria-valuenow={Math.floor(pos)}
            aria-valuemin={0}
            aria-valuemax={Math.floor(track.duration)}
          >
            <div
              className="progress-fill"
              style={{ width: `${progressPct(pos, track.duration)}%` }}
            />
            <div
              className="progress-thumb"
              style={{ left: `${progressPct(pos, track.duration)}%` }}
            />
          </div>
        </div>

        {/* Transport controls + volume */}
        <div className="controls-row">
          <button
            className="ctrl-btn"
            onClick={() => send("previous")}
            aria-label="Previous"
          >
            <SkipBack size={22} />
          </button>

          <button
            className="ctrl-btn play-pause"
            onClick={() => send("playpause")}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>

          <button
            className="ctrl-btn"
            onClick={() => send("next")}
            aria-label="Next"
          >
            <SkipForward size={22} />
          </button>

          {/* Volume */}
          <div className="volume-section">
            <button
              className="volume-btn"
              onClick={() => send("volume", { value: vol > 0 ? 0 : 0.5 })}
              aria-label={vol === 0 ? "Unmute" : "Mute"}
            >
              {vol === 0 ? (
                <VolumeX size={18} />
              ) : vol < 0.5 ? (
                <Volume1 size={18} />
              ) : (
                <Volume2 size={18} />
              )}
            </button>
            <div
              className="volume-slider"
              onClick={handleVolumeClick}
              role="slider"
              aria-label="Volume"
              aria-valuenow={Math.round(vol * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="volume-fill" style={{ width: `${vol * 100}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
