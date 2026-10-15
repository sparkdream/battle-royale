import {
  Box, CRATE_SIZE, type Circle, Crate, type CrateRect, Disc, type GameState, LOOT_AMMO, LOOT_ARMOR,
  LOOT_MEDKIT, Loot, MAP_SIZE, type MapGeometry, PLAYER_RADIUS, type Rect, WEAPONS, WEAPON_RIFLE,
  WEAPON_SHOTGUN, WEAPON_SMG, circleBlocked, inCircles,
} from "@br/shared";

const WALL = 16;
const DOOR = 76;

export interface MapCounts {
  rocks: number;
  buildings: number;
  ponds: number;
  bushes: number;
  crates: number;
}

/** Collision geometry, plus the mutable crate list the room edits as crates break. */
export interface GeneratedMap {
  geo: MapGeometry;
  crates: CrateRect[];
  /** The crate layout as generated, for restoring between matches. */
  initialCrates: readonly CrateRect[];
  /** The layout's seed and stable id (mapIdOf) — what map tokens point at. */
  seed: number;
  id: string;
}

/** Bring back every crate (at full health) for a new match. */
export function resetCrates(state: GameState, map: GeneratedMap) {
  map.crates.length = 0;
  map.crates.push(...map.initialCrates);
  state.crates.clear();
  for (const c of map.initialCrates) state.crates.set(c.id, new Crate({ x: c.x, y: c.y }));
}

/** A fresh 32-bit seed for a room's layout. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * mulberry32: small, fast, good enough for terrain, and — unlike Math.random —
 * the same seed lays out the same map, so a seed plus the counts below
 * regenerates a layout exactly (what map tokens point at).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over seed+counts: the short stable id a map token carries. */
export function mapIdOf(seed: number, counts: MapCounts): string {
  const parts = `${seed}:${counts.buildings}:${counts.rocks}:${counts.ponds}:${counts.bushes}:${counts.crates}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Fill the state with terrain; returns the geometry for collision and vision. */
export function generateMap(
  state: GameState, counts: MapCounts, nextId: () => string, seed = randomSeed(), rng = mulberry32(seed),
): GeneratedMap {
  const buildings: Rect[] = [];
  const walls: Rect[] = [];
  const ponds: Circle[] = [];
  const rocks: Circle[] = [];
  const bushes: Circle[] = [];
  const crates: CrateRect[] = [];

  const nearBuilding = (x: number, y: number, r: number, margin: number) =>
    buildings.some((b) => rectsOverlap(b, { x: x - r, y: y - r, w: r * 2, h: r * 2 }, margin));
  const nearCircle = (list: Circle[], x: number, y: number, r: number, margin: number) =>
    list.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < (o.r + r + margin) ** 2);
  const rand = (min: number, span: number) => min + rng() * span;

  for (let attempt = 0; buildings.length < counts.buildings && attempt < counts.buildings * 50; attempt++) {
    const w = snap(rand(260, 180));
    const h = snap(rand(220, 160));
    const b = { x: snap(rand(150, MAP_SIZE - 300 - w)), y: snap(rand(150, MAP_SIZE - 300 - h)), w, h };
    if (buildings.some((o) => rectsOverlap(o, b, 160))) continue;
    buildings.push(b);
    walls.push(...buildingWalls(b, rng));
  }

  scatter(counts.ponds, () => {
    const r = Math.round(rand(90, 90));
    const { x, y } = randomPoint(r, rng);
    if (nearBuilding(x, y, r, 80) || nearCircle(ponds, x, y, r, 200)) return false;
    ponds.push({ x, y, r });
    return true;
  });

  scatter(counts.rocks, () => {
    const r = Math.round(rand(22, 48));
    const { x, y } = randomPoint(r, rng);
    // Leave room to walk between rocks, and keep them off buildings and ponds.
    if (nearCircle(rocks, x, y, r, PLAYER_RADIUS * 3) || nearCircle(ponds, x, y, r, 20)) return false;
    if (nearBuilding(x, y, r, PLAYER_RADIUS * 3)) return false;
    rocks.push({ x, y, r });
    return true;
  });

  scatter(counts.bushes, () => {
    const r = Math.round(rand(30, 14));
    const { x, y } = randomPoint(r, rng);
    if (nearCircle(rocks, x, y, r, 10) || nearCircle(ponds, x, y, r, 10) || nearCircle(bushes, x, y, r, 40)) return false;
    if (nearBuilding(x, y, r, 20)) return false;
    bushes.push({ x, y, r });
    return true;
  });

  const geo: MapGeometry = { rocks, walls, crates, water: ponds, bushes, buildings };

  // Crates: some in the open, one or two in most buildings.
  const placeCrate = (x: number, y: number) => {
    x = Math.round(x);
    y = Math.round(y);
    const c = x + CRATE_SIZE / 2;
    const m = CRATE_SIZE / 2 + PLAYER_RADIUS * 2;
    if (circleBlocked(geo, c, y + CRATE_SIZE / 2, m) || inCircles(ponds, c, y + CRATE_SIZE / 2) >= 0) return false;
    const id = nextId();
    crates.push({ id, x, y, w: CRATE_SIZE, h: CRATE_SIZE });
    state.crates.set(id, new Crate({ x, y }));
    return true;
  };
  for (const b of buildings) {
    if (rng() < 0.7) placeCrate(
      b.x + WALL + 30 + rng() * (b.w - CRATE_SIZE - WALL * 2 - 60),
      b.y + WALL + 30 + rng() * (b.h - CRATE_SIZE - WALL * 2 - 60),
    );
  }
  scatter(counts.crates, () => placeCrate(rand(80, MAP_SIZE - 160), rand(80, MAP_SIZE - 160)));

  for (const b of buildings) state.floors.push(new Box(b));
  for (const w of walls) state.walls.push(new Box(w));
  for (const r of rocks) state.rocks.push(new Disc(r));
  for (const p of ponds) state.ponds.push(new Disc(p));
  for (const b of bushes) state.bushes.push(new Disc(b));

  return { geo, crates, initialCrates: [...crates], seed, id: mapIdOf(seed, counts) };
}

/** Four walls with a doorway in two or three of them. */
function buildingWalls(b: Rect, rng: () => number = Math.random): Rect[] {
  const sides = ["top", "bottom", "left", "right"] as const;
  const doors = new Set(shuffle([...sides], rng).slice(0, rng() < 0.5 ? 2 : 3));
  const out: Rect[] = [];
  for (const side of sides) {
    const horizontal = side === "top" || side === "bottom";
    const length = horizontal ? b.w : b.h;
    const x = side === "right" ? b.x + b.w - WALL : b.x;
    const y = side === "bottom" ? b.y + b.h - WALL : b.y;
    const segments: [number, number][] = [];
    if (doors.has(side)) {
      const at = snap(WALL + 30 + rng() * (length - DOOR - WALL * 2 - 60));
      segments.push([0, at], [at + DOOR, length]);
    } else {
      segments.push([0, length]);
    }
    for (const [from, to] of segments) {
      out.push(horizontal ? { x: x + from, y, w: to - from, h: WALL } : { x, y: y + from, w: WALL, h: to - from });
    }
  }
  return out;
}

/** Scatter loot, with extra inside buildings. */
export function spawnLoot(state: GameState, geo: MapGeometry, openCount: number, nextId: () => string) {
  for (const b of geo.buildings) {
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0, attempt = 0; i < count && attempt < 30; attempt++) {
      const m = WALL + 24;
      const x = b.x + m + Math.random() * (b.w - m * 2);
      const y = b.y + m + Math.random() * (b.h - m * 2);
      if (circleBlocked(geo, x, y, 20)) continue;
      dropLoot(state, nextId(), randomLootType(), x, y);
      i++;
    }
  }
  scatter(openCount, () => {
    const x = 60 + Math.random() * (MAP_SIZE - 120);
    const y = 60 + Math.random() * (MAP_SIZE - 120);
    if (circleBlocked(geo, x, y, 20) || inCircles(geo.water, x, y) >= 0) return false;
    dropLoot(state, nextId(), randomLootType(), x, y);
    return true;
  });
}

export function dropLoot(state: GameState, id: string, type: number, x: number, y: number, amount?: number) {
  const loot = new Loot();
  loot.type = type;
  loot.x = Math.round(x);
  loot.y = Math.round(y);
  loot.amount = amount ?? WEAPONS[type]?.reserve ?? 0;
  state.loot.set(id, loot);
}

export function randomLootType(): number {
  const roll = Math.random();
  if (roll < 0.16) return WEAPON_SMG;
  if (roll < 0.28) return WEAPON_SHOTGUN;
  if (roll < 0.36) return WEAPON_RIFLE;
  if (roll < 0.6) return LOOT_MEDKIT;
  if (roll < 0.76) return LOOT_ARMOR;
  return LOOT_AMMO;
}

/** Call `tryPlace` until it has succeeded `count` times (or too many attempts failed). */
function scatter(count: number, tryPlace: () => boolean) {
  for (let placed = 0, attempt = 0; placed < count && attempt < count * 30; attempt++) {
    if (tryPlace()) placed++;
  }
}

function randomPoint(margin: number, rng: () => number = Math.random) {
  return {
    x: Math.round(margin + rng() * (MAP_SIZE - margin * 2)),
    y: Math.round(margin + rng() * (MAP_SIZE - margin * 2)),
  };
}

function rectsOverlap(a: Rect, b: Rect, margin: number) {
  return a.x - margin < b.x + b.w && b.x - margin < a.x + a.w && a.y - margin < b.y + b.h && b.y - margin < a.y + a.h;
}

function snap(v: number) {
  return Math.round(v / 10) * 10;
}

function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
