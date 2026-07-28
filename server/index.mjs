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
import { join, resolve, normalize } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import dbus from "dbus-next";

const PORT = parseInt(process.env.PORT ?? "4173");
const PLAYER = process.env.PLAYER ?? ""; // e.g. "qbz" → org.mpris.MediaPlayer2.qbz
// Trusted players by short name (without org.mpris.MediaPlayer2. prefix)
// By default, allow any player that starts with 'qbz' or is explicitly specified via PLAYER env var
const TRUSTED_PLAYERS = process.env.TRUSTED_PLAYERS
  ? process.env.TRUSTED_PLAYERS.split(",").map((s) => s.trim())
  : PLAYER
    ? [PLAYER]
    : []; // If PLAYER env var is set, trust that player
const DIST = join(import.meta.dirname, "..", "dist");

// Track start time for uptime calculation
const startTime = Date.now();

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";
const DBUS_IFACE = "org.freedesktop.DBus";

// ── Secure path validation ───────────────────────────────────────

function resolveSafePath(baseDir, requestedPath) {
  const resolved = resolve(baseDir, requestedPath);
  const normalized = normalize(resolved);
  const baseNormalized = normalize(baseDir);

  if (
    normalized.startsWith(baseNormalized + "/") ||
    normalized === baseNormalized
  ) {
    return resolved;
  }
  return null; // Path traversal attempt
}

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
    try {
      ws.send(str);
    } catch {
      /* ignore closed sockets */
    }
  }
}

// ── MPRIS value helpers ──────────────────────────────────────────

function variantValue(v) {
  // dbus-next wraps values in Variant objects; unwrap recursively
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object" && "value" in v) return variantValue(v.value);
  if (Array.isArray(v)) return v.map(variantValue);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, variantValue(val)]),
    );
  }
  return v;
}

function mprisStatusToStatus(s) {
  if (s === "Playing") return "Playing";
  if (s === "Paused") return "Paused";
  return "Stopped";
}

function mprisLoopToLoop(s) {
  if (s === "Track") return "Track";
  if (s === "Playlist") return "Playlist";
  return "None";
}

function metadataToTrack(meta) {
  if (!meta) return null;
  const title = variantValue(meta["xesam:title"]) ?? "";
  const artistRaw = variantValue(meta["xesam:artist"]) ?? "";
  const artist = Array.isArray(artistRaw)
    ? artistRaw.join(", ")
    : String(artistRaw);
  const album = variantValue(meta["xesam:album"]) ?? "";
  const artUrl = variantValue(meta["mpris:artUrl"]) || undefined;
  const lengthUs = variantValue(meta["mpris:length"]) ?? 0;
  const duration = Number(lengthUs) / 1_000_000;
  if (!title && !artist) return null;
  return { title, artist, album, artUrl, duration };
}

// ── Identity verification ──────────────────────────────────────

async function validatePlayer(serviceName) {
  // If TRUSTED_PLAYERS is empty, allow all players (backward compatible)
  // This is appropriate when the bridge server runs on the user's desktop
  // where any MPRIS player started by the user should be allowed
  if (TRUSTED_PLAYERS.length === 0) {
    return true;
  }

  // Verify the player is in our trusted list
  const shortName = serviceName.replace(MPRIS_PREFIX, "");
  if (!TRUSTED_PLAYERS.includes(shortName)) {
    console.warn(`Rejected untrusted MPRIS player: ${serviceName}`);
    return false;
  }

  // Optional: Verify the D-Bus connection owner is a regular user
  try {
    const dbusObj = await bus.getProxyObject(
      DBUS_IFACE,
      "/org/freedesktop/DBus",
    );
    const dbusIface = dbusObj.getInterface(DBUS_IFACE);
    const uid = await dbusIface.GetConnectionUnixUser(serviceName);
    if (uid < 1000) {
      // UID 0-999 typically system users
      console.warn(`Rejected system-user MPRIS player: ${serviceName}`);
      return false;
    }
  } catch {
    // If we can't verify, still allow if in trusted list (backward compatible)
  }

  return true;
}
// ── Player discovery ─────────────────────────────────────────────

let bus = null;
let playerProxy = null; // org.mpris.MediaPlayer2.Player interface
let propsProxy = null; // org.freedesktop.DBus.Properties interface
let activeName = null; // full D-Bus name e.g. org.mpris.MediaPlayer2.qbz

// Track last playing players for intelligent switching
const lastPlayingPlayers = new Map();

function updateLastPlaying(name) {
  lastPlayingPlayers.set(name, Date.now());
}

// Sort players by most recently active (last 10 minutes)
function sortByRecentActivity(names) {
  const now = Date.now();
  const tenMinutesAgo = now - 10 * 60 * 1000;

  return names
    .map((name) => ({
      name,
      lastActive: lastPlayingPlayers.get(name) ?? 0,
    }))
    .filter((entry) => entry.lastActive > tenMinutesAgo)
    .sort((a, b) => b.lastActive - a.lastActive)
    .map((entry) => entry.name);
}

async function listMprisPlayers() {
  const dbusObj = await bus.getProxyObject(DBUS_IFACE, "/org/freedesktop/DBus");
  const dbusIface = dbusObj.getInterface(DBUS_IFACE);
  const names = await dbusIface.ListNames();
  return names.filter((n) => n.startsWith(MPRIS_PREFIX));
}

async function pickPlayer(names) {
  if (!names.length) return null;

  // If PLAYER env var is set, prioritize it
  if (PLAYER) {
    const target = `${MPRIS_PREFIX}${PLAYER}`;
    const found = names.find((n) => n === target);
    if (found) return found;
  }

  // Sort by recent activity and pick the most recently used one
  const sorted = sortByRecentActivity(names);
  if (sorted.length > 0) {
    return sorted[0];
  }

  // Fallback: pick first in the list
  return names[0];
}

async function connectToPlayer(serviceName) {
  if (activeName === serviceName) return;

  // Validate player identity before connecting
  if (serviceName && !(await validatePlayer(serviceName))) return;

  // Track when we start playing from a new player
  if (serviceName) {
    updateLastPlaying(serviceName);
  }

  // Tear down previous connection
  if (playerProxy) {
    try {
      playerProxy.removeAllListeners();
    } catch {}
    playerProxy = null;
  }
  if (propsProxy) {
    try {
      propsProxy.removeAllListeners();
    } catch {}
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
    propsProxy = obj.getInterface(PROPS_IFACE);

    // ── Read initial state ────────────────────────────────────
    const allProps = variantValue(await propsProxy.GetAll(PLAYER_IFACE));

    const track = metadataToTrack(allProps.Metadata);
    const status = mprisStatusToStatus(allProps.PlaybackStatus);
    const posUs = Number(allProps.Position ?? 0);
    const position = posUs / 1_000_000;
    const volume = Number(allProps.Volume ?? 1);
    const shuffle = Boolean(allProps.Shuffle);
    const loop = mprisLoopToLoop(allProps.LoopStatus);

    state.track = track;
    state.playback = mkPlayback({ status, position, volume, shuffle, loop });
    broadcast({ type: "hello", state });

    // ── Subscribe: property changes (metadata, status, volume, shuffle, loop) ─
    propsProxy.on("PropertiesChanged", (iface, changed) => {
      if (iface !== PLAYER_IFACE) return;
      const c = variantValue(changed);

      let trackDirty = false;
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
          state.playback = {
            ...state.playback,
            status: s,
            timestamp: Date.now(),
          };
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
        state.playback = {
          ...state.playback,
          loop: mprisLoopToLoop(c.LoopStatus),
        };
        playbackDirty = true;
      }

      if (trackDirty) broadcast({ type: "track", track: state.track });
      if (playbackDirty)
        broadcast({ type: "playback", playback: state.playback });
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
  const dbusObj = await bus.getProxyObject(DBUS_IFACE, "/org/freedesktop/DBus");
  const dbusIface = dbusObj.getInterface(DBUS_IFACE);
  const names = await dbusIface.ListNames();
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
  const chosen = await pickPlayer(players);
  if (chosen && chosen !== activeName) {
    await connectToPlayer(chosen);
  } else if (!chosen && activeName) {
    await connectToPlayer(null);
  }
}

// ── D-Bus control commands ───────────────────────────────────────

// Timeout wrapper for async operations
function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`D-Bus call timed out after ${ms}ms`)),
      ms,
    ),
  );
  return Promise.race([promise, timeout]);
}

async function callPlayer(method, ...args) {
  if (!playerProxy) return;
  try {
    await withTimeout(playerProxy[method](...args), 5000); // 5 second timeout
  } catch (err) {
    console.error(`  D-Bus call ${method} failed:`, err.message);
  }
}

async function setProperty(prop, variant) {
  if (!propsProxy) return;
  try {
    await withTimeout(propsProxy.Set(PLAYER_IFACE, prop, variant), 5000); // 5 second timeout
  } catch (err) {
    console.error(`  D-Bus Set ${prop} failed:`, err.message);
  }
}

async function handleCommand(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn("Invalid JSON command");
    return;
  }

  if (!msg?.type || typeof msg.type !== "string") {
    console.warn("Missing or invalid message type");
    return;
  }

  const validator = COMMAND_SCHEMA[msg.type];
  if (!validator) {
    console.warn(`Unknown command type: ${msg.type}`);
    return;
  }

  try {
    const validated = validator(msg);
    // Execute with validated values
    switch (msg.type) {
      case "playpause":
        await callPlayer("PlayPause");
        break;
      case "play":
        await callPlayer("Play");
        break;
      case "pause":
        await callPlayer("Pause");
        break;
      case "next":
        await callPlayer("Next");
        break;
      case "previous":
        await callPlayer("Previous");
        break;
      case "seek": {
        // MPRIS SetPosition takes (TrackId, PositionUs)
        const posUs = Math.round(validated.position * 1_000_000);
        const trackId =
          variantValue(
            (
              await propsProxy?.Get(PLAYER_IFACE, "Metadata").catch(() => null)
            )?.["mpris:trackid"],
          ) ?? "/org/mpris/MediaPlayer2/TrackList/NoTrack";
        await callPlayer("SetPosition", trackId, posUs);
        // Update local state; Seeked signal will also fire
        state.playback = {
          ...state.playback,
          position: validated.position,
          timestamp: Date.now(),
        };
        broadcast({ type: "playback", playback: state.playback });
        break;
      }
      case "volume": {
        const vol = Math.max(0, Math.min(1, validated.value));
        await setProperty("Volume", new dbus.Variant("d", vol));
        state.playback = { ...state.playback, volume: vol };
        broadcast({ type: "playback", playback: state.playback });
        break;
      }
    }
  } catch (err) {
    console.warn(`Command validation failed: ${err.message}`);
  }
}

// ── Command validation schema ──────────────────────────────────

const COMMAND_SCHEMA = {
  playpause: () => ({}),
  play: () => ({}),
  pause: () => ({}),
  next: () => ({}),
  previous: () => ({}),
  seek: (msg) => {
    if (
      typeof msg.position !== "number" ||
      msg.position < 0 ||
      msg.position > 1e9
    ) {
      throw new Error("Invalid position");
    }
    return { position: msg.position };
  },
  volume: (msg) => {
    if (typeof msg.value !== "number" || msg.value < 0 || msg.value > 1) {
      throw new Error("Invalid volume");
    }
    return { value: msg.value };
  },
};

// ── Rate limiting ────────────────────────────────────────────────

const MAX_CONNECTIONS = 10;
const COMMAND_RATE_LIMIT = { windowMs: 1000, maxCommands: 20 };

// Per-client state tracking for rate limiting
const clientStats = new Map();

function cleanupRateLimitStats() {
  const now = Date.now();
  for (const [ws, stats] of clientStats.entries()) {
    if (!clients.has(ws)) {
      clientStats.delete(ws);
      continue;
    }
    stats.commands = stats.commands.filter(
      (t) => now - t < COMMAND_RATE_LIMIT.windowMs,
    );
    if (stats.commands.length === 0) clientStats.delete(ws);
  }
}

// Run cleanup every 10 seconds
setInterval(cleanupRateLimitStats, 10000);

const MIME = {
  html: "text/html; charset=utf-8",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
};

function serveStatic(pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");

  // Security: validate the path doesn't escape DIST
  const filePath = resolveSafePath(DIST, rel);
  if (!filePath) {
    return new Response("Not found", { status: 404 });
  }

  if (existsSync(filePath)) {
    const ext = rel.split(".").pop() ?? "";
    return new Response(readFileSync(filePath), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  // Serve index.html for SPA routing, but only for valid subpaths
  const safeIndex = resolveSafePath(DIST, "index.html");
  if (safeIndex && existsSync(safeIndex)) {
    return new Response(readFileSync(safeIndex), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
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
      console.log(
        `  WebSocket upgrade request from ${origin} (${req.headers.get("host")})`,
      );
      if (srv.upgrade(req, { headers: corsHeaders })) return;
      console.error("  WebSocket upgrade failed — not a valid upgrade request");
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (pathname === "/api/status") {
      const health = {
        dbusConnected: !!playerProxy,
        lastHeartbeat: Date.now(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
        clientCount: clients.size,
        rateLimitWindowMs: COMMAND_RATE_LIMIT.windowMs,
        rateLimitMaxCommands: COMMAND_RATE_LIMIT.maxCommands,
      };
      return Response.json(
        {
          ok: true,
          player: activeName?.replace(MPRIS_PREFIX, "") ?? null,
          clients: clients.size,
          track: state.track?.title ?? null,
          status: state.playback.status,
          health: health,
        },
        { headers: corsHeaders },
      );
    }

    return serveStatic(pathname);
  },

  websocket: {
    open(ws) {
      // Check connection limit
      if (clients.size >= MAX_CONNECTIONS) {
        ws.close(4003, "Server full");
        console.warn("  Rejected connection: server full");
        return;
      }

      clients.add(ws);
      // Initialize rate limiting for this connection
      clientStats.set(ws, { commands: [], lastCleanup: Date.now() });

      const addr = ws.remoteAddress ?? "unknown";
      console.log(`  CarThing connected (${addr}) — ${clients.size} client(s)`);
      ws.send(JSON.stringify({ type: "hello", state }));
    },
    message(ws, data) {
      // Check rate limiting
      const now = Date.now();
      let stats = clientStats.get(ws);
      if (!stats) {
        ws.close(4001, "Connection not established");
        return;
      }

      // Clean old commands
      stats.commands = stats.commands.filter(
        (t) => now - t < COMMAND_RATE_LIMIT.windowMs,
      );

      if (stats.commands.length >= COMMAND_RATE_LIMIT.maxCommands) {
        console.warn(`Rate limit exceeded for connection ${ws.remoteAddress}`);
        ws.close(4002, "Too many commands");
        return;
      }

      stats.commands.push(now);
      handleCommand(String(data));
    },
    close(ws, code) {
      clients.delete(ws);
      clientStats.delete(ws);
      console.log(
        `  CarThing disconnected (code ${code}) — ${clients.size} client(s) remaining`,
      );
    },
  },
});

// ── Start ────────────────────────────────────────────────────────

bus = dbus.sessionBus();

bus.on("error", (err) => {
  console.error("D-Bus error:", err.message);
});

// Watch for MPRIS players appearing and disappearing
const dbusObj = await bus.getProxyObject(DBUS_IFACE, "/org/freedesktop/DBus");
const dbusIface = dbusObj.getInterface(DBUS_IFACE);

// Track which players are currently connected to watch for playback status changes
const activePlayers = new Set();

dbusIface.on("NameOwnerChanged", async (name, oldOwner, newOwner) => {
  if (!name.startsWith(MPRIS_PREFIX)) return;

  // Track active players for monitoring status changes
  if (newOwner && !oldOwner) {
    // New player appeared
    activePlayers.add(name);
    console.log(`  Player appeared: ${name.replace(MPRIS_PREFIX, "")}`);

    // Try to connect to it if we don't have an active player or it's in our trusted list
    if (
      !activeName ||
      (TRUSTED_PLAYERS.length > 0 &&
        TRUSTED_PLAYERS.includes(name.replace(MPRIS_PREFIX, "")))
    ) {
      await connectToPlayer(name);
    }
  } else if (!newOwner && oldOwner) {
    // Player disappeared
    activePlayers.delete(name);
    if (name === activeName) {
      console.log(`  Player left: ${name.replace(MPRIS_PREFIX, "")}`);
      await refreshPlayerList();
    }
  }
});

// Also monitor playback status changes on all active players to trigger automatic switching
async function setupStatusMonitor(playerName) {
  try {
    const obj = await bus.getProxyObject(playerName, MPRIS_PATH);
    const propsProxy = obj.getInterface(PROPS_IFACE);

    propsProxy.on("PropertiesChanged", (iface, changed) => {
      if (iface !== PLAYER_IFACE) return;
      const c = variantValue(changed);

      // If this player started playing and we're following a different player
      if (c.PlaybackStatus === "Playing" && playerName !== activeName) {
        console.log(
          `  Switching to ${playerName.replace(MPRIS_PREFIX, "")}: started playing`,
        );
        connectToPlayer(playerName).catch(() => {});
      }
    });
  } catch (err) {
    console.error(
      `  Failed to setup status monitor for ${playerName}:`,
      err.message,
    );
  }
}

// Update refreshPlayerList to also set up status monitors for all players
async function refreshPlayerListWithMonitors() {
  const players = await listMprisPlayers();

  // Setup status monitors for all players
  for (const player of players) {
    if (player !== activeName && activePlayers.has(player)) {
      setupStatusMonitor(player);
    }
  }

  const chosen = await pickPlayer(players);
  if (chosen && chosen !== activeName) {
    await connectToPlayer(chosen);
  } else if (!chosen && activeName) {
    await connectToPlayer(null);
  }
}

// Initial player discovery
await refreshPlayerListWithMonitors();

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
