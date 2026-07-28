export type PlaybackStatus = "Playing" | "Paused" | "Stopped";
export type LoopMode = "None" | "Track" | "Playlist";

export interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  artUrl?: string;
  duration: number; // seconds
}

export interface PlaybackState {
  status: PlaybackStatus;
  position: number; // seconds
  volume: number; // 0–1
  shuffle: boolean;
  loop: LoopMode;
  timestamp: number; // Date.now() when position was sampled
}

export interface BridgeFullState {
  playerName: string | null;
  track: TrackInfo | null;
  playback: PlaybackState;
}

// Messages sent from the bridge server to the CarThing app
export type ServerMessage =
  | { type: "hello"; state: BridgeFullState }
  | { type: "track"; track: TrackInfo }
  | { type: "playback"; playback: PlaybackState }
  | { type: "player"; playerName: string | null };

// Messages sent from the CarThing app to the bridge server
export type ClientMessage =
  | { type: "playpause" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; position: number }
  | { type: "volume"; value: number };
