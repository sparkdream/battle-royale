import { BUSH_REVEAL_RANGE, MAP_SIZE, PLAYER_RADIUS, PLAYER_SPEED, TICK_DT, VIEW_RANGE, WATER_SPEED } from "./constants";
import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP } from "./protocol";

export interface Vec { x: number; y: number }
export interface Circle { x: number; y: number; r: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface CrateRect extends Rect { id: string }

/** Everything on the map that affects movement, bullets or vision. */
export interface MapGeometry {
  /** Block movement and bullets. */
  rocks: readonly Circle[];
  /** Block movement, bullets and vision. */
  walls: readonly Rect[];
  /** Block movement and bullets until destroyed. */
  crates: readonly CrateRect[];
  /** Slow movement. */
  water: readonly Circle[];
  /** Hide whoever is inside from anyone not right next to them. */
  bushes: readonly Circle[];
  /** Building floors: whoever is under a roof is hidden from those outside it. */
  buildings: readonly Rect[];
}

export function emptyGeometry(): MapGeometry {
  return { rocks: [], walls: [], crates: [], water: [], bushes: [], buildings: [] };
}

const DIAGONAL = Math.SQRT1_2;

/**
 * Advance a player by one fixed step. Runs on the server (authoritative) and
 * on the client (prediction), so it must stay deterministic: no randomness,
 * no wall-clock time.
 */
export function stepPlayer(p: Vec, keys: number, geo: MapGeometry): void {
  let dx = 0;
  let dy = 0;
  if (keys & KEY_UP) dy -= 1;
  if (keys & KEY_DOWN) dy += 1;
  if (keys & KEY_LEFT) dx -= 1;
  if (keys & KEY_RIGHT) dx += 1;
  if (dx !== 0 && dy !== 0) {
    dx *= DIAGONAL;
    dy *= DIAGONAL;
  }

  const speed = PLAYER_SPEED * TICK_DT * (inCircles(geo.water, p.x, p.y) >= 0 ? WATER_SPEED : 1);
  p.x += dx * speed;
  p.y += dy * speed;

  for (const rock of geo.rocks) pushOutOfCircle(p, rock, PLAYER_RADIUS);
  for (const wall of geo.walls) pushOutOfRect(p, wall, PLAYER_RADIUS);
  for (const crate of geo.crates) pushOutOfRect(p, crate, PLAYER_RADIUS);

  p.x = clamp(p.x, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
  p.y = clamp(p.y, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
}

function pushOutOfCircle(p: Vec, c: Circle, radius: number) {
  const ox = p.x - c.x;
  const oy = p.y - c.y;
  const min = c.r + radius;
  const d2 = ox * ox + oy * oy;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2);
  if (d === 0) {
    p.x = c.x + min;
  } else {
    p.x = c.x + (ox / d) * min;
    p.y = c.y + (oy / d) * min;
  }
}

function pushOutOfRect(p: Vec, r: Rect, radius: number) {
  const cx = clamp(p.x, r.x, r.x + r.w);
  const cy = clamp(p.y, r.y, r.y + r.h);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    p.x = cx + (dx / d) * radius;
    p.y = cy + (dy / d) * radius;
    return;
  }
  // Center is inside the box: leave by the nearest side.
  const left = p.x - r.x;
  const right = r.x + r.w - p.x;
  const top = p.y - r.y;
  const bottom = r.y + r.h - p.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) p.x = r.x - radius;
  else if (m === right) p.x = r.x + r.w + radius;
  else if (m === top) p.y = r.y - radius;
  else p.y = r.y + r.h + radius;
}

/** Whether a circle at (x, y) overlaps anything solid or the map edge. */
export function circleBlocked(geo: MapGeometry, x: number, y: number, r: number): boolean {
  if (x < r || y < r || x > MAP_SIZE - r || y > MAP_SIZE - r) return true;
  for (const o of geo.rocks) {
    const min = o.r + r;
    if ((o.x - x) ** 2 + (o.y - y) ** 2 < min * min) return true;
  }
  return rectsTouchCircle(geo.walls, x, y, r) || rectsTouchCircle(geo.crates, x, y, r);
}

function rectsTouchCircle(rects: readonly Rect[], x: number, y: number, r: number): boolean {
  for (const w of rects) {
    const dx = x - clamp(x, w.x, w.x + w.w);
    const dy = y - clamp(y, w.y, w.y + w.h);
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

export interface RayHit {
  /** Fraction along the segment, in [0, 1]. */
  t: number;
  /** Set when the thing hit was a crate. */
  crateId?: string;
}

/**
 * First solid thing (rock, wall or crate) along the segment, or null if the
 * path is clear. `pad` thickens the segment (e.g. by the bullet radius).
 */
export function raycastSolid(
  geo: MapGeometry, x0: number, y0: number, x1: number, y1: number, pad = 0,
): RayHit | null {
  let best: RayHit | null = null;
  for (const o of geo.rocks) {
    const t = segmentCircleHit(x0, y0, x1, y1, o.x, o.y, o.r + pad);
    if (t >= 0 && (!best || t < best.t)) best = { t };
  }
  for (const w of geo.walls) {
    const t = segmentRectHit(x0, y0, x1, y1, w.x - pad, w.y - pad, w.w + pad * 2, w.h + pad * 2);
    if (t >= 0 && (!best || t < best.t)) best = { t };
  }
  for (const c of geo.crates) {
    const t = segmentRectHit(x0, y0, x1, y1, c.x - pad, c.y - pad, c.w + pad * 2, c.h + pad * 2);
    if (t >= 0 && (!best || t < best.t)) best = { t, crateId: c.id };
  }
  return best;
}

/** Like raycastSolid, but just the fraction (-1 if clear). */
export function firstSolidHit(
  geo: MapGeometry, x0: number, y0: number, x1: number, y1: number, pad = 0,
): number {
  return raycastSolid(geo, x0, y0, x1, y1, pad)?.t ?? -1;
}

/**
 * Whether someone at (ax, ay) can see someone at (bx, by). Walls block sight;
 * rocks and crates are low enough to see over. Used by the server to decide
 * what each client is sent, and by bots so they play by the same rules.
 */
export function canSee(geo: MapGeometry, ax: number, ay: number, bx: number, by: number): boolean {
  const d2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (d2 > VIEW_RANGE * VIEW_RANGE) return false;
  const roof = inRects(geo.buildings, bx, by);
  if (roof >= 0 && roof !== inRects(geo.buildings, ax, ay)) return false;
  if (d2 > BUSH_REVEAL_RANGE * BUSH_REVEAL_RANGE && inCircles(geo.bushes, bx, by) >= 0) return false;
  for (const w of geo.walls) {
    if (segmentRectHit(ax, ay, bx, by, w.x, w.y, w.w, w.h) >= 0) return false;
  }
  return true;
}

/** Index of the first rect containing the point, or -1. */
export function inRects(rects: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

/** Index of the first circle containing the point, or -1. */
export function inCircles(circles: readonly Circle[], x: number, y: number): number {
  for (let i = 0; i < circles.length; i++) {
    const c = circles[i];
    if ((c.x - x) ** 2 + (c.y - y) ** 2 <= c.r * c.r) return i;
  }
  return -1;
}

/**
 * Where along the segment (x0,y0)→(x1,y1) it first touches the circle, as a
 * fraction in [0, 1], or -1 if it misses. Swept so fast bullets can't tunnel.
 */
export function segmentCircleHit(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, r: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0; // starts inside
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Same as segmentCircleHit, for an axis-aligned box (slab method). */
export function segmentRectHit(
  x0: number, y0: number, x1: number, y1: number,
  rx: number, ry: number, rw: number, rh: number,
): number {
  let tMin = 0;
  let tMax = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < rx || x0 > rx + rw) return -1;
  } else {
    let t1 = (rx - x0) / dx;
    let t2 = (rx + rw - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < ry || y0 > ry + rh) return -1;
  } else {
    let t1 = (ry - y0) / dy;
    let t2 = (ry + rh - y0) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }
  return tMin;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
