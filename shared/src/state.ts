import { schema, t, type SchemaType } from "@colyseus/schema";
import { CRATE_HP, MAP_SIZE, MAX_HEALTH, ZONE_START_RADIUS } from "./constants";
import { PHASE_LOBBY } from "./protocol";
import { WEAPON_NONE, WEAPON_PISTOL } from "./weapons";

// Field order is the wire format: append new fields, don't reorder (once deployed).

export const Player = schema({
  name: t.string().default(""),
  x: t.float32().default(0),
  y: t.float32().default(0),
  angle: t.float32().default(0),
  hp: t.uint8().default(MAX_HEALTH),
  alive: t.boolean().default(true),
  kills: t.uint16().default(0),
  // Last input seq the server applied; the client replays inputs after it.
  lastSeq: t.uint32().default(0),
  bot: t.boolean().default(false),
  armor: t.uint8().default(0),
  /** Index into PLAYER_COLORS. */
  color: t.uint8().default(0),
  // Inventory: two weapon slots (WEAPON_NONE when empty), each with its own
  // magazine and spare rounds.
  slot: t.uint8().default(0),
  w0: t.uint8().default(WEAPON_PISTOL),
  w1: t.uint8().default(WEAPON_NONE),
  mag0: t.uint8().default(0),
  mag1: t.uint8().default(0),
  res0: t.uint16().default(0),
  res1: t.uint16().default(0),
  medkits: t.uint8().default(0),
  reloading: t.boolean().default(false),
  healing: t.boolean().default(false),
  /** Still in the drop plane: invisible, untouchable, follows the plane. */
  inPlane: t.boolean().default(false),
}, "Player");
export type Player = SchemaType<typeof Player>;

// Bullets are never mutated after spawning: clients simulate the flight from
// the spawn point, so only the add and the remove go over the wire.
export const Bullet = schema({
  owner: t.string().default(""),
  x: t.float32().default(0),
  y: t.float32().default(0),
  angle: t.float32().default(0),
  weapon: t.uint8().default(0),
}, "Bullet");
export type Bullet = SchemaType<typeof Bullet>;

/** A circle: rocks, ponds and bushes. */
export const Disc = schema({
  x: t.uint16().default(0),
  y: t.uint16().default(0),
  r: t.uint8().default(0),
}, "Disc");
export type Disc = SchemaType<typeof Disc>;

export const Box = schema({
  x: t.uint16().default(0),
  y: t.uint16().default(0),
  w: t.uint16().default(0),
  h: t.uint16().default(0),
}, "Box");
export type Box = SchemaType<typeof Box>;

/** A destructible CRATE_SIZE square with its top-left at (x, y). */
export const Crate = schema({
  x: t.uint16().default(0),
  y: t.uint16().default(0),
  hp: t.uint8().default(CRATE_HP),
}, "Crate");
export type Crate = SchemaType<typeof Crate>;

export const Loot = schema({
  type: t.uint8().default(0),
  x: t.uint16().default(0),
  y: t.uint16().default(0),
  /** Spare rounds, for weapon loot. */
  amount: t.uint16().default(0),
}, "Loot");
export type Loot = SchemaType<typeof Loot>;

/** Current safe circle (x, y, r) and the circle it will shrink to next (tx, ty, tr). */
export const Zone = schema({
  x: t.float32().default(MAP_SIZE / 2),
  y: t.float32().default(MAP_SIZE / 2),
  r: t.float32().default(ZONE_START_RADIUS),
  tx: t.float32().default(MAP_SIZE / 2),
  ty: t.float32().default(MAP_SIZE / 2),
  tr: t.float32().default(ZONE_START_RADIUS),
  shrinking: t.boolean().default(false),
}, "Zone");
export type Zone = SchemaType<typeof Zone>;

/** The drop plane flies from (x0, y0) to (x1, y1); `t` is its progress, 0..1. */
export const Plane = schema({
  x0: t.float32().default(0),
  y0: t.float32().default(0),
  x1: t.float32().default(0),
  y1: t.float32().default(0),
  t: t.float32().default(0),
}, "Plane");
export type Plane = SchemaType<typeof Plane>;

export const GameState = schema({
  // Each client only receives the players it can see (see canSee()).
  players: t.map(Player).view(),
  bullets: t.map(Bullet),
  rocks: t.array(Disc),
  walls: t.array(Box),
  /** Building floors; roofs cover them. */
  floors: t.array(Box),
  ponds: t.array(Disc),
  bushes: t.array(Disc),
  crates: t.map(Crate),
  loot: t.map(Loot),
  zone: t.ref(Zone).default(() => new Zone()),
  plane: t.ref(Plane).default(() => new Plane()),
  phase: t.string().default(PHASE_LOBBY),
  /** Seconds left in the lobby/results countdown, or until the zone's next move. */
  timer: t.uint16().default(0),
  // Totals, since clients can't count players they can't see.
  playerCount: t.uint8().default(0),
  aliveCount: t.uint8().default(0),
  difficulty: t.string().default("normal"),
}, "GameState");
export type GameState = SchemaType<typeof GameState>;
