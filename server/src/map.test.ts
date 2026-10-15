import { describe, expect, it } from "vitest";
import { GameState } from "@br/shared";
import { generateMap, mapIdOf, mulberry32 } from "./map";

const COUNTS = { rocks: 30, buildings: 4, ponds: 3, bushes: 10, crates: 8 };

describe("seeded map generation", () => {
  it("the same seed lays out the identical map", () => {
    const a = generateMap(new GameState(), COUNTS, () => "a", 123456);
    const b = generateMap(new GameState(), COUNTS, () => "b", 123456);
    expect(a.geo.buildings).toEqual(b.geo.buildings);
    expect(a.geo.walls).toEqual(b.geo.walls);
    expect(a.geo.rocks).toEqual(b.geo.rocks);
    expect(a.geo.water).toEqual(b.geo.water);
    expect(a.geo.bushes).toEqual(b.geo.bushes);
    expect(a.crates.map((c) => [c.x, c.y])).toEqual(b.crates.map((c) => [c.x, c.y]));
    expect(a.id).toBe(b.id);
  });

  it("different seeds produce different layouts and ids", () => {
    const a = generateMap(new GameState(), COUNTS, () => "a", 1);
    const b = generateMap(new GameState(), COUNTS, () => "b", 2);
    expect(a.id).not.toBe(b.id);
    expect(a.geo.buildings).not.toEqual(b.geo.buildings);
  });

  it("counts still hold under a seed", () => {
    const map = generateMap(new GameState(), COUNTS, () => "x", 42);
    expect(map.geo.buildings).toHaveLength(COUNTS.buildings);
    expect(map.geo.rocks).toHaveLength(COUNTS.rocks);
    expect(map.geo.bushes).toHaveLength(COUNTS.bushes);
  });

  it("mapIdOf distinguishes count changes and is stable", () => {
    expect(mapIdOf(7, COUNTS)).toBe(mapIdOf(7, COUNTS));
    expect(mapIdOf(7, COUNTS)).not.toBe(mapIdOf(8, COUNTS));
    expect(mapIdOf(7, COUNTS)).not.toBe(mapIdOf(7, { ...COUNTS, rocks: COUNTS.rocks + 1 }));
  });

  it("mulberry32 is deterministic and in range", () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    const first = Array.from({ length: 5 }, () => a());
    const second = Array.from({ length: 5 }, () => b());
    expect(first).toEqual(second);
    for (const v of first) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });
});
