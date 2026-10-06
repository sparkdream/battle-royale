// Simulation rate. One client input == one fixed step == one server tick.
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const MAP_SIZE = 3000;
export const MAX_PLAYERS = 50;

export const PLAYER_RADIUS = 18;
export const PLAYER_SPEED = 260; // px/s
/** Speed multiplier while standing in water. */
export const WATER_SPEED = 0.55;
export const MAX_HEALTH = 100;
export const MAX_ARMOR = 100;
/** Share of weapon damage that armor soaks up (until the armor runs out). */
export const ARMOR_ABSORB = 0.5;

/** Distinct player colors; the server hands them out least-used first. */
export const PLAYER_COLORS: readonly number[] = [
  0xe6194b, 0xf58231, 0xffe119, 0x4363d8, 0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4, 0x469990,
  0xdcbeff, 0x9a6324, 0xfffac8, 0x800000, 0xaaffc3, 0xffd8b1, 0x000075, 0xffffff, 0x3cb44b, 0x222222,
];

export const BULLET_RADIUS = 4;
export const MUZZLE_OFFSET = PLAYER_RADIUS + 8;

export const PICKUP_RADIUS = PLAYER_RADIUS + 16;
export const MEDKIT_HEAL = 50;
export const MEDKIT_TICKS = Math.round(2.5 * TICK_RATE);
export const MAX_MEDKITS = 3;

export const CRATE_SIZE = 40;
export const CRATE_HP = 60;

// Vision. Players further than VIEW_RANGE, behind walls, under a roof you're
// not under, or in a bush you're not right next to are not sent to you.
export const VIEW_RANGE = 1400;
export const BUSH_REVEAL_RANGE = 130;

// Match flow, in seconds.
export const LOBBY_SECONDS = 15;
export const DROP_SECONDS = 18;
export const ENDED_SECONDS = 10;
export const MIN_PLAYERS_TO_START = 2;

// The zone starts out covering the whole map, then each stage waits, shrinks
// to `radius`, and hurts anyone outside it by `dps` (ignores armor).
export const ZONE_START_RADIUS = Math.ceil(MAP_SIZE * 0.72);
export const ZONE_STAGES: readonly { wait: number; shrink: number; radius: number; dps: number }[] = [
  { wait: 40, shrink: 30, radius: 1100, dps: 2 },
  { wait: 30, shrink: 25, radius: 650, dps: 4 },
  { wait: 25, shrink: 20, radius: 350, dps: 7 },
  { wait: 20, shrink: 15, radius: 150, dps: 10 },
  { wait: 15, shrink: 15, radius: 0, dps: 15 },
];

// How far in the past the client renders other players, so it always has two
// server snapshots to interpolate between.
export const INTERP_DELAY_MS = 100;
/** Cap on how far back the server rewinds targets for a shooter's latency. */
export const LAG_COMP_MAX_MS = 300;
/** Seconds a dropped connection keeps its seat before the player is removed. */
export const RECONNECT_SECONDS = 20;
