#!/usr/bin/env bun
// Qobuz CarThing bridge server
// Polls MPRIS via playerctl and streams state to the CarThing over WebSocket.
// Control commands from the CarThing are executed via playerctl.
//
// Usage:
//   bun server/index.mjs
//   PORT=4173 PLAYER=qbz bun server/index.mjs
//
// PLAYER env var: playerctl -p <name> — set to your QBZ/qbzd player name.
// Leave empty to use the currently active MPRIS player.
// Run `playerctl --list-all` to see available player names.

import { serve } from "bun";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const PORT = parseInt(process.env.PORT ?? "4173");
const PLAYER = process.env.PLAYER ?? "";
const DIST = join(import.meta.dirname, "..", "dist");

// Separator used inside playerctl --format to split fields.
// Chosen to be extremely unlikely to appear in music metadata.
const SEP = "\x1d"; // ASCII Group Separator

// ── MPRIS helpers ───────────────────────────────────────────────

function pc(args) {
  const cmd = ["playerctl"];
  if (PLAYER) cmd.push("-p", PLAYER);
  cmd.push(...args);
  return cmd;
}

function run(args) {
  const proc = Bun.spawnSync(pc(args), { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out || null;
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
  playerName: PLAYER || null,
  track: null,
  playback: mkPlayback(),
};

const clients = new Set();

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(str); } catch { /* client may have closed */ }
  }
}

// ── Poll MPRIS ───────────────────────────────────────────────────

let prevTrackKey = "";

async function pollOnce() {
  const status = run(["status"]);

  if (!status) {
    if (state.playback.status !== "Stopped") {
      state.playback = mkPlayback();
      state.track = null;
      broadcast({ type: "playback", playback: state.playback });
      broadcast({ type: "track", track: null });
    }
    return;
  }

  const normalStatus = status === "Playing" ? "Playing" : status === "Paused" ? "Paused" : "Stopped";

  // Position (seconds, float)
  const posStr = run(["position"]);
  const position = posStr ? parseFloat(posStr) : state.playback.position;

  // Volume (0–1)
  const volStr = run(["volume"]);
  const volume = volStr != null ? parseFloat(volStr) : state.playback.volume;

  // All metadata in one invocation
  const metaFmt = `{{title}}${SEP}{{artist}}${SEP}{{album}}${SEP}{{mpris:artUrl}}${SEP}{{mpris:length}}`;
  const metaStr = run(["metadata", "--format", metaFmt]);

  if (metaStr) {
    const parts = metaStr.split(SEP);
    const title    = (parts[0] ?? "").trim();
    const artist   = (parts[1] ?? "").trim();
    const album    = (parts[2] ?? "").trim();
    const artUrl   = (parts[3] ?? "").trim() || undefined;
    const lenMicro = parseInt(parts[4] ?? "0") || 0;
    const duration = lenMicro / 1_000_000;

    const trackKey = `${title}|${artist}|${album}`;
    if (trackKey !== prevTrackKey) {
      prevTrackKey = trackKey;
      state.track = { title, artist, album, artUrl, duration };
      broadcast({ type: "track", track: state.track });
    } else if (artUrl !== state.track?.artUrl) {
      // Art URL can lag behind — update it when it arrives
      state.track = { ...state.track, artUrl };
      broadcast({ type: "track", track: state.track });
    }
  }

  const newPlayback = {
    status: normalStatus,
    position,
    volume,
    shuffle: false,
    loop: "None",
    timestamp: Date.now(),
  };

  const statusChanged = state.playback.status !== normalStatus;
  const posJumped = Math.abs(state.playback.position - position) > 2;
  const volChanged = Math.abs(state.playback.volume - volume) > 0.02;

  if (statusChanged || posJumped || volChanged) {
    state.playback = newPlayback;
    broadcast({ type: "playback", playback: newPlayback });
  } else if (normalStatus === "Playing") {
    // Update timestamp so clients can interpolate smoothly
    state.playback = newPlayback;
    broadcast({ type: "playback", playback: newPlayback });
  }
}

// ── Control commands ─────────────────────────────────────────────

function handleCommand(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case "playpause": run(["play-pause"]); break;
    case "play":      run(["play"]);       break;
    case "pause":     run(["pause"]);      break;
    case "next":      run(["next"]);       break;
    case "previous":  run(["previous"]);   break;
    case "seek": {
      const pos = parseFloat(msg.position);
      if (Number.isFinite(pos)) run(["position", String(pos)]);
      break;
    }
    case "volume": {
      const vol = Math.max(0, Math.min(1, parseFloat(msg.value)));
      if (Number.isFinite(vol)) run(["volume", String(vol.toFixed(4))]);
      break;
    }
    default:
      return;
  }

  // Immediate poll so the new state reaches the client quickly
  setTimeout(pollOnce, 80);
}

// ── Static file serving ──────────────────────────────────────────

const MIME = {
  html: "text/html; charset=utf-8",
  js:   "application/javascript",
  mjs:  "application/javascript",
  css:  "text/css",
  json: "application/json",
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  svg:  "image/svg+xml",
  ico:  "image/x-icon",
  woff2:"font/woff2",
  woff: "font/woff",
};

function serveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const filePath = join(DIST, rel);

  if (existsSync(filePath)) {
    const ext = rel.split(".").pop() ?? "";
    const contentType = MIME[ext] ?? "application/octet-stream";
    return new Response(readFileSync(filePath), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  }

  // SPA fallback
  const index = join(DIST, "index.html");
  if (existsSync(index)) {
    return new Response(readFileSync(index), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new Response("Not found — run `bun run build` first", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

// ── HTTP + WebSocket server ──────────────────────────────────────

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(req, server) {
    const { pathname } = new URL(req.url);

    if (pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (pathname === "/api/status") {
      return Response.json({
        ok: true,
        player: PLAYER || "auto",
        connected: clients.size,
        track: state.track?.title ?? null,
        status: state.playback.status,
      });
    }

    return serveStatic(pathname);
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "hello", state }));
    },
    message(ws, data) {
      handleCommand(String(data));
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

// ── Poll loop ────────────────────────────────────────────────────

async function loop() {
  await pollOnce();
  // Poll faster while playing so progress stays accurate
  const delay = state.playback.status === "Playing" ? 500 : 2000;
  setTimeout(loop, delay);
}

loop();

// ── Startup message ──────────────────────────────────────────────

console.log(`
  Qobuz CarThing Bridge
  ─────────────────────────────────────
  App       →  http://localhost:${PORT}
  WebSocket →  ws://localhost:${PORT}/ws
  Status    →  http://localhost:${PORT}/api/status
  Player    →  ${PLAYER || "(auto-detect active MPRIS player)"}

  Point your CarThing Chromium at:
    http://<this-machine-ip>:${PORT}

  Tip: run \`playerctl --list-all\` to see MPRIS player names,
       then set PLAYER=<name> if you want to target QBZ specifically.
`);
