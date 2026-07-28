#!/usr/bin/env bun
// Qobuz CarThing bridge server
// Connects to the D-Bus session bus and subscribes to MPRIS signals directly —
// no polling, no subprocess spawning. Streams playback state to the CarThing
// over WebSocket and translates control commands back to MPRIS method calls.
//
// Usage:
//   bun server/index.mjs
//   PORT=4173 PLAYER=qbz bun server/index.mjs
//
// PLAYER env var: target a specific MPRIS player by short name (e.g. "qbz").
// Leave empty to follow the most recently active player automatically.

import { serve } from "bun";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import dbus from "dbus-next";

const PORT = parseInt(process.env.PORT ?? "4173");
const PLAYER = process.env.PLAYER ?? ""; // e.g. "qbz" → org.mpris.MediaPlayer2.qbz
const DIST = join(import.meta.dirname, "..", "dist");

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH   = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const PROPS_IFACE  = "org.freedesktop.DBus.Properties";
const DBUS_IFACE   = "org.freedesktop.DBus";

// ── State ────────────────────────────────────────────────────────

function mkPlayback(overrides = {}) {
  return {
    status: "Stopped",
    position: 0,
    volume: 1,
    shuffle: false,
    loop: "None",
    timestamp: Date.now(),
    ...overrides,
  };
}

let state = {
  playerName: null,
  track: null,
  playback: mkPlayback(),
};

// ── WebSocket clients ────────────────────────────────────────────

const clients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(str); } catch { /* ignore closed sockets */ }
  }
}

// ── MPRIS value helpers ──────────────────────────────────────────

function variantValue(v) {
  // dbus-next wraps values in Variant objects; unwrap recursively
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object" && "value" in v) return variantValue(v.value);
  if (Array.isArray(v)) return v.map(variantValue);
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, variantValue(val)]));
  }
  return v;
}

function mprisStatusToStatus(s) {
  if (s === "Playing") return "Playing";
  if (s === "Paused")  return "Paused";
  return "Stopped";
}

function mprisLoopToLoop(s) {
  if (s === "Track")    return "Track";
  if (s === "Playlist") return "Playlist";
  return "None";
}

function metadataToTrack(meta) {
  if (!meta) return null;
  const title    = variantValue(meta["xesam:title"])  ?? "";
  const artistRaw= variantValue(meta["xesam:artist"]) ?? "";
  const artist   = Array.isArray(artistRaw) ? artistRaw.join(", ") : String(artistRaw);
  const album    = variantValue(meta["xesam:album"])  ?? "";
  const artUrl   = variantValue(meta["mpris:artUrl"]) || undefined;
  const lengthUs = variantValue(meta["mpris:length"]) ?? 0;
  const duration = Number(lengthUs) / 1_000_000;
  if (!title && !artist) return null;
  return { title, artist, album, artUrl, duration };
}

// ── Active player management ─────────────────────────────────────

let bus = null;
let playerProxy = null; // org.mpris.MediaPlayer2.Player interface
let propsProxy  = null; // org.freedesktop.DBus.Properties interface
let activeName  = null; // full D-Bus name e.g. org.mpris.MediaPlayer2.qbz

async function connectToPlayer(serviceName) {
  if (activeName === serviceName) return;

  // Tear down previous connection
  if (playerProxy) {
    try { playerProxy.removeAllListeners(); } catch {}
    playerProxy = null;
  }
  if (propsProxy) {
    try { propsProxy.removeAllListeners(); } catch {}
    propsProxy = null;
  }

  activeName = serviceName;
  const shortName = serviceName.replace(MPRIS_PREFIX, "");
  state.playerName = shortName;

  if (!serviceName) {
    state.track = null;
    state.playback = mkPlayback();
    broadcast({ type: "hello", state });
    return;
  }

  try {
    const obj = await bus.getProxyObject(serviceName, MPRIS_PATH);
    playerProxy = obj.getInterface(PLAYER_IFACE);
    propsProxy  = obj.getInterface(PROPS_IFACE);

    // ── Read initial state ────────────────────────────────────
    const allProps = variantValue(await propsProxy.GetAll(PLAYER_IFACE));

    const track    = metadataToTrack(allProps.Metadata);
    const status   = mprisStatusToStatus(allProps.PlaybackStatus);
    const posUs    = Number(allProps.Position ?? 0);
    const position = posUs / 1_000_000;
    const volume   = Number(allProps.Volume ?? 1);
    const shuffle  = Boolean(allProps.Shuffle);
    const loop     = mprisLoopToLoop(allProps.LoopStatus);

    state.track   = track;
    state.playback = mkPlayback({ status, position, volume, shuffle, loop });
    broadcast({ type: "hello", state });

    // ── Subscribe: property changes (metadata, status, volume, shuffle, loop) ─
    propsProxy.on("PropertiesChanged", (iface, changed) => {
      if (iface !== PLAYER_IFACE) return;
      const c = variantValue(changed);

      let trackDirty    = false;
      let playbackDirty = false;

      if ("Metadata" in c) {
        const t = metadataToTrack(c.Metadata);
        if (JSON.stringify(t) !== JSON.stringify(state.track)) {
          state.track = t;
          trackDirty = true;
        }
      }
      if ("PlaybackStatus" in c) {
        const s = mprisStatusToStatus(c.PlaybackStatus);
        if (s !== state.playback.status) {
          state.playback = { ...state.playback, status: s, timestamp: Date.now() };
          playbackDirty = true;
        }
      }
      if ("Volume" in c) {
        const v = Number(c.Volume);
        if (Math.abs(v - state.playback.volume) > 0.01) {
          state.playback = { ...state.playback, volume: v };
          playbackDirty = true;
        }
      }
      if ("Shuffle" in c) {
        state.playback = { ...state.playback, shuffle: Boolean(c.Shuffle) };
        playbackDirty = true;
      }
      if ("LoopStatus" in c) {
        state.playback = { ...state.playback, loop: mprisLoopToLoop(c.LoopStatus) };
        playbackDirty = true;
      }

      if (trackDirty)    broadcast({ type: "track",    track:    state.track });
      if (playbackDirty) broadcast({ type: "playback", playback: state.playback });
    });

    // ── Subscribe: seek events (gives exact new position) ────
    playerProxy.on("Seeked", (positionUs) => {
      const position = Number(positionUs) / 1_000_000;
      state.playback = { ...state.playback, position, timestamp: Date.now() };
      broadcast({ type: "playback", playback: state.playback });
    });

    console.log(`  Connected to player: ${shortName}`);
  } catch (err) {
    console.error(`  Failed to connect to ${serviceName}:`, err.message);
    activeName = null;
  }
}

// ── Player discovery ─────────────────────────────────────────────

async function listMprisPlayers() {
  const dbusObj  = await bus.getProxyObject(DBUS_IFACE, "/org/freedesktop/DBus");
  const dbusIface = dbusObj.getInterface(DBUS_IFACE);
  const names    = await dbusIface.ListNames();
  return names.filter((n) => n.startsWith(MPRIS_PREFIX));
}

async function pickPlayer(names) {
  if (!names.length) return null;
  if (PLAYER) {
    const target = `${MPRIS_PREFIX}${PLAYER}`;
    return names.find((n) => n === target) ?? names[0];
  }
  return names[0];
}

async function refreshPlayerList() {
  const players = await listMprisPlayers();
  const chosen  = await pickPlayer(players);
  if (chosen && chosen !== activeName) {
    await connectToPlayer(chosen);
  } else if (!chosen && activeName) {
    await connectToPlayer(null);
  }
}

// ── D-Bus control commands ───────────────────────────────────────

async function callPlayer(method, ...args) {
  if (!playerProxy) return;
  try {
    await playerProxy[method](...args);
  } catch (err) {
    console.error(`  D-Bus call ${method} failed:`, err.message);
  }
}

async function setProperty(prop, variant) {
  if (!propsProxy) return;
  try {
    await propsProxy.Set(PLAYER_IFACE, prop, variant);
  } catch (err) {
    console.error(`  D-Bus Set ${prop} failed:`, err.message);
  }
}

async function handleCommand(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case "playpause": await callPlayer("PlayPause"); break;
    case "play":      await callPlayer("Play");      break;
    case "pause":     await callPlayer("Pause");     break;
    case "next":      await callPlayer("Next");      break;
    case "previous":  await callPlayer("Previous");  break;
    case "seek": {
      // MPRIS SetPosition takes (TrackId, PositionUs)
      const posUs = Math.round(parseFloat(msg.position) * 1_000_000);
      const trackId = variantValue(
        (await propsProxy?.Get(PLAYER_IFACE, "Metadata").catch(() => null))?.["mpris:trackid"]
      ) ?? "/org/mpris/MediaPlayer2/TrackList/NoTrack";
      await callPlayer("SetPosition", trackId, posUs);
      // Update local state; Seeked signal will also fire
      state.playback = { ...state.playback, position: parseFloat(msg.position), timestamp: Date.now() };
      broadcast({ type: "playback", playback: state.playback });
      break;
    }
    case "volume": {
      const vol = Math.max(0, Math.min(1, parseFloat(msg.value)));
      await setProperty("Volume", new dbus.Variant("d", vol));
      state.playback = { ...state.playback, volume: vol };
      broadcast({ type: "playback", playback: state.playback });
      break;
    }
  }
}

// ── Static file serving ──────────────────────────────────────────

const MIME = {
  html: "text/html; charset=utf-8",
  js:   "application/javascript",
  css:  "text/css",
  json: "application/json",
  png:  "image/png",
  jpg:  "image/jpeg", jpeg: "image/jpeg",
  svg:  "image/svg+xml",
  ico:  "image/x-icon",
  woff2:"font/woff2", woff: "font/woff",
};

function serveStatic(pathname) {
  const rel      = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = join(DIST, rel);

  if (existsSync(filePath)) {
    const ext = rel.split(".").pop() ?? "";
    return new Response(readFileSync(filePath), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" },
    });
  }

  const index = join(DIST, "index.html");
  if (existsSync(index)) {
    return new Response(readFileSync(index), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new Response("Not found — run `npm run build` first", { status: 404 });
}

// ── HTTP + WebSocket server ──────────────────────────────────────

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Handle pre-flight and add CORS for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (pathname === "/ws") {
      const origin = req.headers.get("origin") ?? "unknown";
      console.log(`  WebSocket upgrade request from ${origin} (${req.headers.get("host")})`);
      if (srv.upgrade(req, { headers: corsHeaders })) return;
      console.error("  WebSocket upgrade failed — not a valid upgrade request");
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (pathname === "/api/status") {
      return Response.json({
        ok: true,
        player: activeName?.replace(MPRIS_PREFIX, "") ?? null,
        clients: clients.size,
        track: state.track?.title ?? null,
        status: state.playback.status,
      }, { headers: corsHeaders });
    }

    return serveStatic(pathname);
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      const addr = ws.remoteAddress ?? "unknown";
      console.log(`  CarThing connected (${addr}) — ${clients.size} client(s)`);
      ws.send(JSON.stringify({ type: "hello", state }));
    },
    message(ws, data) {
      handleCommand(String(data));
    },
    close(ws, code) {
      clients.delete(ws);
      console.log(`  CarThing disconnected (code ${code}) — ${clients.size} client(s) remaining`);
    },
  },
});

// ── Start ────────────────────────────────────────────────────────

bus = dbus.sessionBus();

bus.on("error", (err) => {
  console.error("D-Bus error:", err.message);
});

// Watch for MPRIS players appearing and disappearing
const dbusObj   = await bus.getProxyObject(DBUS_IFACE, "/org/freedesktop/DBus");
const dbusIface = dbusObj.getInterface(DBUS_IFACE);

dbusIface.on("NameOwnerChanged", async (name, oldOwner, newOwner) => {
  if (!name.startsWith(MPRIS_PREFIX)) return;

  if (newOwner && !oldOwner) {
    // New player appeared
    if (!activeName || (PLAYER && name === `${MPRIS_PREFIX}${PLAYER}`)) {
      await connectToPlayer(name);
    }
  } else if (!newOwner && oldOwner) {
    // Player disappeared
    if (name === activeName) {
      console.log(`  Player left: ${name.replace(MPRIS_PREFIX, "")}`);
      await refreshPlayerList();
    }
  }
});

// Initial player discovery
await refreshPlayerList();

console.log(`
  Qobuz CarThing Bridge
  ─────────────────────────────────────
  App       →  http://localhost:${PORT}
  WebSocket →  ws://localhost:${PORT}/ws
  Status    →  http://localhost:${PORT}/api/status
  Player    →  ${PLAYER || "(auto — follows active MPRIS player)"}

  Point the CarThing Chromium at:
    http://<this-machine-ip>:${PORT}
`);
