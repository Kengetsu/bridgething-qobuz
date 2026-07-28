# Qobuz CarThing

A [BridgeThing](https://bridgething.com) app that mirrors Qobuz playback from your Linux desktop to the Spotify Car Thing. Displays the currently playing track with cover art, a live progress bar, and full transport controls (play/pause, skip, seek, volume).

Audio stays on the desktop. The Car Thing is purely a display and controller.

## How it works

A bridge server runs on your desktop, subscribes to [QBZ](https://github.com/vicrodh/qbz)'s MPRIS output over D-Bus, and streams state to the Car Thing over WebSocket. The Car Thing app connects to the bridge and renders the now-playing UI.

```
QBZ (desktop) → MPRIS/D-Bus → Bridge Server → WebSocket → Car Thing
```

## Prerequisites

- Linux desktop with [QBZ](https://github.com/vicrodh/qbz) installed
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Node.js + npm (for building the Car Thing app)
- A Car Thing running [BridgeThing](https://bridgething.com) firmware

## Setup

```sh
git clone https://github.com/Kengetsu/bridgething-qobuz.git
cd bridgething-qobuz
npm install
```

## Running

### 1. Find your QBZ player name

```sh
playerctl --list-all
# Look for something like "qbz" or "com.blitzfc.qbz"
```

### 2. Build the app

```sh
npm run build
```

### 3. Start the bridge server

```sh
# Auto-detect the active MPRIS player:
bun server/index.mjs

# Or target QBZ specifically:
PLAYER=qbz bun server/index.mjs
```

The server starts at `http://0.0.0.0:4173`. Open `http://localhost:4173/api/status` to confirm it's running.

### 4. Connect the Car Thing

Point the Car Thing's Chromium to `http://<your-desktop-ip>:4173`.

If you're deploying as a BridgeThing package (see below), set the Bridge URL in the companion app settings instead.

## BridgeThing Package Deployment

To install as a proper BridgeThing app:

```sh
npm run release:bridgething
# → release/qobuz-carthing-bridgething-v0.1.0.zip
```

Install the ZIP via the BridgeThing companion app. Once installed, open the app's settings in the companion app and enter your bridge server URL (`ws://<desktop-ip>:4173/ws`).

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PORT` | `4173` | Port the bridge server listens on |
| `PLAYER` | *(auto)* | MPRIS player name — leave empty to follow the active player |

## Build Scripts

| Script | Output |
|---|---|
| `npm run dev` | Dev server at `:5173` |
| `npm run build` | Production build in `dist/` |
| `npm run build:bridgething` | BridgeThing package build (ES2022 + settings page) |
| `npm run release:bridgething` | Build + ZIP → `release/` |
| `npm run build:device` | Chrome 69 compatible build for direct device deployment |

## Project Structure

```
server/         Bridge server (Bun + dbus-next)
src/            Car Thing app (React/TypeScript)
settings/       Companion app settings page
public/         manifest.json (BridgeThing app identity)
scripts/        Build and packaging utilities
planning/       Architecture documentation
```

## Works with any MPRIS player

The bridge reads from whatever MPRIS player is active — QBZ, qbzd, Spotify, VLC, etc. Set `PLAYER=<name>` to lock it to a specific one.

## License

MIT
