export const KEY_UP = 1;
export const KEY_DOWN = 2;
export const KEY_LEFT = 4;
export const KEY_RIGHT = 8;
// Action keys are edge-triggered on the server: holding them acts once.
export const KEY_INTERACT = 16;
export const KEY_RELOAD = 32;
export const KEY_HEAL = 64;
export const KEY_JUMP = 128;
export const KEY_MASK = 255;

export const PHASE_LOBBY = "lobby";
export const PHASE_DROP = "drop";
export const PHASE_PLAYING = "playing";
export const PHASE_ENDED = "ended";

export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

// client -> server
export const MSG_INPUT = "i";
export const MSG_LATENCY = "lat";
export const MSG_SPECTATE_NEXT = "specnext";
// server -> client
export const MSG_KILL = "kill";
export const MSG_HIT = "hit";
export const MSG_STATS = "stats";
export const MSG_SPECTATE = "spec";
export const MSG_MATCH_END = "end";

/** Sent by the client once per fixed step. */
export interface InputMessage {
  /** Monotonic per-client sequence number, echoed back as Player.lastSeq. */
  seq: number;
  /** Bitmask of KEY_* flags. */
  keys: number;
  /** Aim angle in radians. */
  angle: number;
  fire: boolean;
  /** Weapon slot the player wants active (0 or 1). The server switches when this changes. */
  slot: number;
}

/** Broadcast to everyone for the kill feed. `killer` is "" for zone deaths. */
export interface KillMessage {
  killer: string;
  victim: string;
  weapon: string;
}

/** Sent to a shooter when one of their bullets hits a player. */
export interface HitMessage {
  x: number;
  y: number;
  damage: number;
  kill: boolean;
}

/** Sent to a player when their match is over (eliminated, or won). */
export interface StatsMessage {
  place: number;
  kills: number;
  damage: number;
  survivedSeconds: number;
  /** "" if the zone got them; also "" for the winner. */
  killer: string;
}

/** Tells a dead player whose eyes they're watching through. */
export interface SpectateMessage {
  id: string;
  name: string;
}

export interface MatchEndMessage {
  winner: string;
  winnerId: string;
  leaderboard: { name: string; kills: number }[];
}

export interface JoinOptions {
  name?: string;
  difficulty?: Difficulty;
}
