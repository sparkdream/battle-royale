import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, achievementByCode, newAchievements } from "./achievements";
import { emptyCareer, mergeCareer, type MatchEntry } from "./web3";

function entry(over: Partial<MatchEntry> = {}): MatchEntry {
  return {
    address: "sprkdrm1player",
    name: "Ada",
    place: 2,
    kills: 1,
    damage: 100,
    survivedSeconds: 120,
    items: {},
    crates: 0,
    mapId: "abc",
    mapSeed: 7,
    matchId: "0123456789abcdef",
    ...over,
  };
}

/** Codes a first match like `e` earns on an empty career. */
function firstMatch(e: MatchEntry, already: string[] = []) {
  return newAchievements(mergeCareer(emptyCareer("Ada"), e), e, already).map((a) => a.code);
}

describe("achievements", () => {
  it("lists unique codes", () => {
    const codes = ACHIEVEMENTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(achievementByCode("last-one-standing")?.title).toBe("Last one standing");
  });

  it("unlocks first blood and the first win together", () => {
    const got = firstMatch(entry({ place: 1, kills: 3 }));
    expect(got).toEqual(["dropped-in", "first-blood", "last-one-standing"]);
  });

  it("gunslinger needs 5 eliminations with the win", () => {
    expect(firstMatch(entry({ place: 1, kills: 5 }))).toContain("gunslinger");
    // No win, many kills: sharpshooter but not gunslinger.
    const got = firstMatch(entry({ place: 4, kills: 10 }));
    expect(got).toContain("sharpshooter");
    expect(got).not.toContain("gunslinger");
  });

  it("never re-unlocks what the career already has", () => {
    const already = ["dropped-in", "first-blood", "last-one-standing", "rampage", "gunslinger", "sharpshooter"];
    expect(firstMatch(entry({ place: 1, kills: 10 }), already)).toEqual([]);
  });

  it("collector needs all three special weapons over the career", () => {
    const e = entry({ items: { "1": 2, "2": 1 } });
    const career = mergeCareer(emptyCareer("Ada"), e);
    expect(newAchievements(career, e, []).map((a) => a.code)).not.toContain("collector");
    const e2 = entry({ items: { "3": 1 } });
    expect(newAchievements(mergeCareer(career, e2), e2, []).map((a) => a.code)).toContain("collector");
  });

  it("threshold achievements use the totals including this match", () => {
    // 99 kills before, 1 in this match: big game hunter lands exactly at 100.
    const e = entry({ kills: 1 });
    const merged = mergeCareer({ ...emptyCareer("Ada"), kills: 99 }, e);
    expect(newAchievements(merged, e, []).map((a) => a.code)).toContain("big-game-hunter");
  });

  it("survivor needs four minutes", () => {
    expect(firstMatch(entry({ survivedSeconds: 239 }))).not.toContain("survivor");
    expect(firstMatch(entry({ survivedSeconds: 240 }))).toContain("survivor");
  });
});

describe("mergeCareer", () => {
  it("accumulates items, damage and best place", () => {
    let career = mergeCareer(emptyCareer("Ada"), entry({ place: 3, kills: 2, damage: 150.4, items: { "1": 1 }, crates: 2 }));
    career = mergeCareer(career, entry({ place: 1, kills: 1, damage: 50, items: { "1": 1, "10": 3 }, crates: 1 }));
    // Same room, same layout: one map played, not two.
    expect(career).toMatchObject({
      matches: 2, wins: 1, kills: 3, damage: 200, bestPlace: 1, crates: 3,
      items: { "1": 2, "10": 3 }, mapsPlayed: 1, lastMap: "abc",
    });
    career = mergeCareer(career, entry({ mapId: "def" }));
    expect(career.mapsPlayed).toBe(2);
  });

  it("keeps the latest name", () => {
    const career = mergeCareer(emptyCareer("Ada"), entry({ name: "Grace" }));
    expect(career.name).toBe("Grace");
  });
});
