# Phase 1 — Qobuz CarThing Bridge

## Goal

Mirror playback from **QBZ** (a native Qobuz desktop client for Linux) to a **Spotify Car Thing** device running the **BridgeThing** custom firmware. The Car Thing should display the currently playing track — title, artist, album, cover art, and a live progress bar — and expose full transport controls (play/pause, skip, seek, volume) from the touchscreen.

The user plays music via QBZ on their Linux desktop. The Car Thing acts as a remote display and controller, with no audio routing involved.

---

## Scope

Phase 1 establishes the full end-to-end pipeline from desktop playback state to on-device UI. It covers:

- A **bridge server** that runs on the Linux desktop, reads playback state from QBZ via MPRIS over D-Bus, and streams it to the Car Thing over WebSocket.
- A **BridgeThing app** (React, packaged for the BridgeThing runtime) that connects to the bridge server, renders the now-playing UI, and sends control commands back.
- A **companion settings page** rendered inside the BridgeThing phone app for configuring the bridge server URL and screen brightness.

What is **not** in scope for Phase 1:
- Audio routing to the Car Thing (audio stays on the desktop)
- Qobuz library browsing or search
- Queue management
- Hardware button/knob mapping (physical controls on the Car Thing)
- Multi-room or Qobuz Connect receiver mode

---

## Technologies Integrated

### BridgeThing (`@bridgething/client` v0.4.0)
Custom firmware and SDK for the Spotify Car Thing that replaces the stock Spotify OS. The Car Thing runs a Chromium kiosk at 800×480. Apps are TypeScript/React SPAs packaged as ZIP archives containing an `index.html`, a `manifest.json` (app identity and config schema), and a `settings.html` (companion phone UI built as a single inlined file).

The SDK exposes event/request/command surfaces: `config` (persistent key-value store), `doc` (per-device document store), `hardware` (backlight, ambient light), `net` (proxied WebSocket/fetch), and others. The settings page uses a separate mini SDK (`@bridgething/client/settings`) to read and write config from the companion phone app.

The app detects whether it is running as a BridgeThing package (loaded from `file://`) or from the bridge server directly, and adjusts its URL resolution strategy accordingly.

- SDK docs: https://bridgething.com/docs/sdk/
- Reference implementation studied: https://github.com/nwo122383/MusicAssistant_Bridgething

### QBZ / MPRIS
QBZ is an open-source native Qobuz client for Linux built in Rust with a Slint UI. It exposes playback state via **MPRIS** (Media Player Remote Interfacing Specification), the standard Linux D-Bus interface for media players. MPRIS is implemented on the session bus under service names of the form `org.mpris.MediaPlayer2.<name>` and exposes:

- `PlaybackStatus` — Playing / Paused / Stopped
- `Metadata` — track title, artist, album, artwork URL, duration (in microseconds)
- `Position` — current playback position (in microseconds)
- `Volume` — 0.0–1.0
- `Shuffle`, `LoopStatus`
- Methods: `Play`, `Pause`, `PlayPause`, `Next`, `Previous`, `SetPosition`, `Seek`
- Signals: `PropertiesChanged` (via `org.freedesktop.DBus.Properties`), `Seeked`

Because MPRIS is a well-established Linux standard, the bridge works with any MPRIS-compliant player (QBZ, qbzd, Spotify, VLC, etc.) without modification.

- QBZ repo: https://github.com/vicrodh/qbz
- MPRIS spec: https://wiki.archlinux.org/title/MPRIS

### dbus-next (v0.10.2)
A pure JavaScript D-Bus client library. Used in the bridge server to connect directly to the D-Bus session bus without spawning external processes. The server subscribes to `PropertiesChanged` and `Seeked` signals for instant event-driven updates, and issues MPRIS method calls for playback control. No polling; no subprocess spawning.

`dbus-next` has no native addons (pure JS over Unix sockets via Node.js `net`), making it compatible with the Bun runtime.

- Repo: https://github.com/nicktindall/cyclon.p2p-rtc-server (upstream: dbus-next by dbusjs)

### Bun
JavaScript runtime used to run the bridge server (`server/index.mjs`). Chosen because the BridgeThing ecosystem is Bun-based. The server uses `Bun.serve()` for the combined HTTP + WebSocket server with zero additional dependencies.

### React 19 + Vite 8 + TypeScript 6
Standard frontend stack for the Car Thing app. The main app targets `es2022` for BridgeThing package builds and `chrome69` for direct device builds (the Car Thing runs an older Chromium). The settings page is bundled into a single self-contained HTML file using `vite-plugin-singlefile`.

### lucide-react (v1.27.0)
Icon library used for the player UI (play/pause, skip, volume icons).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Linux Desktop                                               │
│                                                              │
│  ┌─────────────────┐    MPRIS / D-Bus    ┌───────────────┐  │
│  │   QBZ (Qobuz    │ ──────────────────► │ Bridge Server │  │
│  │   desktop app)  │                     │ (Bun + dbus-  │  │
│  └─────────────────┘                     │  next)        │  │
│                                          │               │  │
│                                          │  port 4173    │  │
│                                          └───────┬───────┘  │
└──────────────────────────────────────────────────┼──────────┘
                                                   │ WebSocket (ws://)
                                                   │ HTTP (static files)
                          ┌────────────────────────▼────────┐
                          │  Spotify Car Thing               │
                          │  (BridgeThing firmware)          │
                          │                                  │
                          │  Chromium kiosk 800×480          │
                          │  ┌────────────────────────────┐  │
                          │  │  Qobuz CarThing App        │  │
                          │  │  (React / BridgeThing SDK) │  │
                          │  └────────────────────────────┘  │
                          └──────────────────────────────────┘
```

### Bridge Server (`server/index.mjs`)

Runs on the Linux desktop. Responsibilities:

1. **D-Bus connection** — Connects to the session bus on startup via `dbus-next`.
2. **Player discovery** — Lists all `org.mpris.MediaPlayer2.*` services; watches `NameOwnerChanged` for players appearing and disappearing. Optionally targets a specific player via the `PLAYER` environment variable.
3. **Signal subscriptions** — On connecting to a player, subscribes to `PropertiesChanged` (fires on metadata, status, volume, shuffle, loop changes) and `Seeked` (fires on position jumps with the new position).
4. **Initial state fetch** — On connect, calls `GetAll(org.mpris.MediaPlayer2.Player)` to read the current full state and broadcasts it to any connected CarThing clients.
5. **WebSocket broadcast** — All connected Car Thing clients receive JSON messages: `hello` (full state on connect), `track` (metadata change), `playback` (status/position/volume change).
6. **Control commands** — Receives JSON commands from Car Thing clients and executes them as D-Bus method calls on the active MPRIS player.
7. **Static file serving** — Serves the built `dist/` directory so the Car Thing can load the app from the bridge server directly (development and bridge-server deployment modes).

Environment variables:
- `PORT` (default `4173`) — listening port
- `PLAYER` (default empty, auto-detects) — short MPRIS player name (e.g. `qbz`)

### WebSocket Message Protocol

**Server → Client:**

| Type | Payload | When |
|---|---|---|
| `hello` | `{ state: BridgeFullState }` | On WebSocket connect |
| `track` | `{ track: TrackInfo \| null }` | Track metadata changes |
| `playback` | `{ playback: PlaybackState }` | Status, volume, position jumps |
| `player` | `{ playerName: string \| null }` | Active player changes |

**Client → Server:**

| Type | Payload | Action |
|---|---|---|
| `playpause` | — | MPRIS `PlayPause` |
| `play` | — | MPRIS `Play` |
| `pause` | — | MPRIS `Pause` |
| `next` | — | MPRIS `Next` |
| `previous` | — | MPRIS `Previous` |
| `seek` | `{ position: number }` (seconds) | MPRIS `SetPosition` |
| `volume` | `{ value: number }` (0–1) | MPRIS property `Set Volume` |

### Car Thing App (`src/`)

React SPA with three runtime states:

- **Connecting** — spinner while the WebSocket handshake completes or reconnects (auto-reconnects every 3 s).
- **Nothing playing** — shown when connected but the player status is Stopped or no track is active.
- **Now playing** — main view: album art (200×200 with blurred art as background), track title/artist/album, seekable progress bar, transport controls, volume slider.

Position is interpolated locally between server updates so the progress bar stays smooth without polling. The `Seeked` MPRIS signal gives an exact resync whenever the user seeks.

**URL resolution** (`src/lib/bridge.ts`):
1. If running as a BridgeThing package (`file://` protocol): reads `bridgeUrl` from BridgeThing config via `@bridgething/client`.
2. If served from the bridge server: derives `ws://[window.location.host]/ws` from the page origin.
3. Fallback (localStorage): for manual configuration when running outside both contexts.

### Settings Page (`settings/`)

A standalone React page built into a single inlined HTML file (`settings.html`) by `vite-plugin-singlefile`. It is rendered inside the BridgeThing companion phone app when the user opens the Qobuz app settings. Uses `@bridgething/client/settings` to read and write:

- `bridgeUrl` (config store) — WebSocket URL of the bridge server
- `brightnessMode` / `brightnessLevel` (doc store) — screen brightness preference

---

## File Structure

```
bridgething/
├── planning/
│   └── phase-1.md              ← this document
├── public/
│   └── manifest.json           ← BridgeThing app manifest
├── scripts/
│   ├── package-bridgething.mjs ← builds release ZIP from dist/
│   └── transpile-chrome69.mjs  ← downtranspiles JS for Chrome 69
├── server/
│   └── index.mjs               ← bridge server (Bun + dbus-next)
├── settings/
│   ├── main.tsx                ← companion settings React component
│   ├── settings.html           ← settings page entry point
│   └── style.css               ← settings page styles
├── src/
│   ├── App.tsx                 ← main CarThing UI
│   ├── lib/
│   │   └── bridge.ts           ← WebSocket client + runtime detection
│   ├── main.tsx
│   ├── styles.css
│   ├── types.ts                ← shared message + state types
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── vite.config.ts
└── vite.settings.config.ts     ← settings page build config
```

---

## Build Outputs

| Script | Output | Use case |
|---|---|---|
| `npm run dev` | Dev server at `:5173` | Local development |
| `npm run build` | `dist/` | General production build |
| `npm run build:bridgething` | `dist/` (ES2022 + settings.html) | BridgeThing package build |
| `npm run release:bridgething` | `release/*.zip` | Install via BridgeThing companion app |
| `npm run build:device` | `dist/` (Chrome 69) | Direct device deployment |
| `bun server/index.mjs` | Runs on `:4173` | Bridge server |

---

## Key Design Decisions

**Event-driven D-Bus over playerctl polling.** An earlier iteration used `playerctl` subprocesses polled every 500 ms. This was replaced with a persistent `dbus-next` connection that subscribes to MPRIS signals. The result is instant reaction to track changes with no process spawning overhead.

**MPRIS over PipeWire-native or Qobuz Connect APIs.** PipeWire carries audio routing metadata only and has no standard track-level metadata fields. Qobuz Connect protocol internals are proprietary and require reverse engineering. MPRIS is the well-established standard interface that QBZ already implements, making it the correct integration layer.

**Bridge server hosts the app.** In bridge-server mode, the server serves the built static files on the same port as the WebSocket. This means the Car Thing only needs to know one IP and port, the WebSocket URL is derived automatically from the page origin, and there is no CORS configuration needed.

**BridgeThing config for URL storage.** When packaged as a BridgeThing app, the bridge URL is stored in the BridgeThing config store (readable/writable from the companion phone app's settings UI) rather than in the app itself. This matches the pattern established by the BridgeThing ecosystem.

**Position interpolation on the client.** MPRIS does not emit continuous position updates — only `Seeked` events on jumps. The server records a `timestamp` alongside each `position` value; the Car Thing app interpolates forward from that anchor while playback is active. The `Seeked` signal provides exact resyncs.

---

## Dependencies

### Runtime (bridge server)
| Package | Version | Purpose |
|---|---|---|
| `dbus-next` | 0.10.2 | D-Bus session bus client (MPRIS) |
| Bun | system | Runtime + WebSocket server |

### Runtime (Car Thing app)
| Package | Version | Purpose |
|---|---|---|
| `@bridgething/client` | 0.4.0 | BridgeThing SDK (config, hardware) |
| `react` + `react-dom` | 19.2.8 | UI framework |
| `lucide-react` | 1.27.0 | Icons |

### Build / Dev
| Package | Version | Purpose |
|---|---|---|
| `vite` | 8.1.5 | Build tool |
| `@vitejs/plugin-react` | 6.0.4 | React/JSX transform |
| `vite-plugin-singlefile` | 2.3.3 | Inlines settings page into one HTML file |
| `esbuild` | 0.28.1 | Chrome 69 transpilation for device builds |
| `typescript` | 6.0.3 | Type checking |

---

## Sources and References

| Source | URL | How used |
|---|---|---|
| BridgeThing SDK docs | https://bridgething.com/docs/sdk/ | API surfaces, app structure, manifest format |
| MusicAssistant_Bridgething | https://github.com/nwo122383/MusicAssistant_Bridgething | Reference implementation for packaging, settings page structure, runtime detection pattern, build scripts |
| QBZ | https://github.com/vicrodh/qbz | MPRIS interface understanding, player name conventions |
| yet-another-quentin/qbzd | https://github.com/yet-another-quentin/qbzd | REST/SSE API considered and ruled out for this phase |
| MPRIS spec (ArchWiki) | https://wiki.archlinux.org/title/MPRIS | D-Bus interface specification, signal/property names |
| dbus-next | https://github.com/nicktindall/cyclon.p2p-rtc-server | Pure JS D-Bus client, Bun compatibility |
| Sendspin CLI | https://github.com/Sendspin/sendspin-cli | Evaluated as alternative — multi-room audio, out of scope |
| leolobato/qobuz-proxy | https://github.com/leolobato/qobuz-proxy | Evaluated as alternative — DLNA bridge, out of scope |

---

## Known Limitations and Open Questions

- **Hardware buttons** — The Car Thing has a rotary knob, five preset buttons, and a back button. These are not wired up in Phase 1. They would require subscribing to BridgeThing's `hardware` SDK events and mapping to MPRIS commands. See Phase 2 for rate limiting and security concerns when implementing.

- **Album art over file://** — When the app is deployed as a BridgeThing package, artwork URLs (HTTPS CDN links from Qobuz) need to be reachable from the Car Thing's network. If the Car Thing has no internet access, art will not load. See Phase 2 for network permission troubleshooting steps.

- **Multi-player disambiguation** — If multiple MPRIS players are active simultaneously, the server follows the first discovered or the explicitly configured `PLAYER` name. A future UI affordance could let the user switch players. **IMPORTANT:** Automatic player switching is now documented as a critical feature for Phase 2 - see "Feature Request: Automatic MPRIS Player Switching" in phase-2.md.

- **Bun availability** — The bridge server requires Bun. The tooling assumes Bun is installed on the user's desktop (`curl -fsSL https://bun.sh/install | bash`).

- **dbus-next Bun compatibility** — `dbus-next` is pure JavaScript and expected to work under Bun. This has not been integration-tested in a live D-Bus session within this development environment.

- **Qobuz Connect mode** — If the user wants to cast music from the Qobuz mobile app to the desktop (rather than using QBZ directly), they would need `qbzd` running as a Connect receiver. `qbzd watch` could replace or supplement the MPRIS interface in a future phase.

- **WebSocket connection issues** — The BridgeThing app may fail to connect to the WebSocket endpoint even when config is set. This is documented in Phase 2 with diagnostic steps and potential fixes for config fallback chain implementation.
