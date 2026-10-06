import { describe, expect, it } from "vitest";
import { MAP_SIZE, PLAYER_RADIUS, PLAYER_SPEED, TICK_DT, VIEW_RANGE, WATER_SPEED } from "./constants";
import { KEY_DOWN, KEY_RIGHT } from "./protocol";
import {
  type MapGeometry, canSee, circleBlocked, emptyGeometry, raycastSolid, segmentCircleHit,
  segmentRectHit, stepPlayer,
} from "./sim";

const geo = (parts: Partial<MapGeometry>): MapGeometry => ({ ...emptyGeometry(), ...parts });

describe("stepPlayer", () => {
  it("moves at PLAYER_SPEED and normalizes diagonals", () => {
    const p = { x: 1000, y: 1000 };
    stepPlayer(p, KEY_RIGHT, emptyGeometry());
    expect(p.x - 1000).toBeCloseTo(PLAYER_SPEED * TICK_DT);

    const d = { x: 1000, y: 1000 };
    stepPlayer(d, KEY_RIGHT | KEY_DOWN, emptyGeometry());
    expect(Math.hypot(d.x - 1000, d.y - 1000)).toBeCloseTo(PLAYER_SPEED * TICK_DT);
  });

  it("is slowed by water", () => {
    const p = { x: 1000, y: 1000 };
    stepPlayer(p, KEY_RIGHT, geo({ water: [{ x: 1000, y: 1000, r: 100 }] }));
    expect(p.x - 1000).toBeCloseTo(PLAYER_SPEED * TICK_DT * WATER_SPEED);
  });

  it("can't walk through rocks, walls or crates", () => {
    const wall = { x: 100, y: 100, w: 100, h: 20 };
    const crate = { id: "c", x: 400, y: 100, w: 40, h: 40 };
    const g = geo({ rocks: [{ x: 700, y: 120, r: 30 }], walls: [wall], crates: [crate] });
    for (const startX of [150, 420, 700]) {
      const p = { x: startX, y: 40 };
      for (let i = 0; i < 30; i++) stepPlayer(p, KEY_DOWN, g);
      expect(p.y).toBeLessThanOrEqual(100 - PLAYER_RADIUS + 0.01 + (startX === 700 ? 30 : 0));
      expect(circleBlocked(g, p.x, p.y, PLAYER_RADIUS - 0.5)).toBe(false);
    }
  });

  it("stays on the map", () => {
    const p = { x: MAP_SIZE - 5, y: 500 };
    stepPlayer(p, KEY_RIGHT, emptyGeometry());
    expect(p.x).toBe(MAP_SIZE - PLAYER_RADIUS);
  });

  it("gives the same result when inputs are replayed (what prediction relies on)", () => {
    const g = geo({ rocks: [{ x: 1100, y: 1050, r: 40 }] });
    const inputs = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? KEY_RIGHT | KEY_DOWN : KEY_RIGHT));
    const live = { x: 1000, y: 1000 };
    for (const k of inputs) stepPlayer(live, k, g);
    // Rewind halfway, then replay the rest.
    const half = { x: 1000, y: 1000 };
    for (const k of inputs.slice(0, 30)) stepPlayer(half, k, g);
    const replay = { ...half };
    for (const k of inputs.slice(30)) stepPlayer(replay, k, g);
    expect(replay).toEqual(live);
  });
});

describe("ray tests", () => {
  it("finds where a segment enters a circle or box", () => {
    expect(segmentCircleHit(0, 0, 100, 0, 50, 0, 10)).toBeCloseTo(0.4);
    expect(segmentCircleHit(0, 0, 100, 0, 50, 30, 10)).toBe(-1);
    expect(segmentRectHit(150, 60, 150, 110, 100, 100, 100, 20)).toBeCloseTo(0.8);
    expect(segmentRectHit(0, 0, 50, 50, 100, 100, 100, 20)).toBe(-1);
  });

  it("reports which crate it hit, and the nearest hit wins", () => {
    const g = geo({ rocks: [{ x: 300, y: 0, r: 10 }], crates: [{ id: "c1", x: 100, y: -20, w: 40, h: 40 }] });
    expect(raycastSolid(g, 0, 0, 400, 0)).toEqual({ t: 0.25, crateId: "c1" });
    expect(raycastSolid(g, 200, 0, 400, 0)?.crateId).toBeUndefined();
    expect(raycastSolid(g, 0, 100, 400, 100)).toBeNull();
  });
});

describe("canSee", () => {
  const building = { x: 1000, y: 1000, w: 300, h: 300 };

  it("is limited by range", () => {
    expect(canSee(emptyGeometry(), 0, 0, VIEW_RANGE - 1, 0)).toBe(true);
    expect(canSee(emptyGeometry(), 0, 0, VIEW_RANGE + 1, 0)).toBe(false);
  });

  it("is blocked by walls but not rocks or crates", () => {
    expect(canSee(geo({ walls: [{ x: 50, y: -50, w: 16, h: 100 }] }), 0, 0, 200, 0)).toBe(false);
    expect(canSee(geo({ rocks: [{ x: 100, y: 0, r: 30 }], crates: [{ id: "c", x: 60, y: -20, w: 40, h: 40 }] }), 0, 0, 200, 0)).toBe(true);
  });

  it("hides players under a roof from those outside it", () => {
    const g = geo({ buildings: [building] });
    expect(canSee(g, 900, 1150, 1150, 1150)).toBe(false); // outside looking in
    expect(canSee(g, 1100, 1150, 1150, 1150)).toBe(true); // same building
    expect(canSee(g, 1150, 1150, 900, 1150)).toBe(true); // inside looking out
  });

  it("hides players in bushes unless you're right next to them", () => {
    const g = geo({ bushes: [{ x: 500, y: 500, r: 35 }] });
    expect(canSee(g, 200, 500, 500, 500)).toBe(false);
    expect(canSee(g, 400, 500, 500, 500)).toBe(true);
  });
});
