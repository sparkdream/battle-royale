import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Leaderboard } from "./leaderboard";

describe("leaderboard", () => {
  it("adds up results by name, case-insensitively", () => {
    const board = new Leaderboard(null);
    board.record("Ada", { place: 3, kills: 2, damage: 150.4 });
    board.record("ada", { place: 1, kills: 4, damage: 300 });
    expect(board.top(10)).toEqual([expect.objectContaining({
      name: "ada", matches: 2, wins: 1, kills: 6, damage: 450, bestPlace: 1,
    })]);
  });

  it("ranks by wins, then kills, then fewest matches", () => {
    const board = new Leaderboard(null);
    board.record("Many kills", { place: 2, kills: 9, damage: 0 });
    board.record("Winner", { place: 1, kills: 1, damage: 0 });
    board.record("Few kills", { place: 2, kills: 1, damage: 0 });
    board.record("Slow", { place: 2, kills: 1, damage: 0 });
    board.record("Slow", { place: 5, kills: 0, damage: 0 });
    expect(board.top(10).map((e) => e.name)).toEqual(["Winner", "Many kills", "Few kills", "Slow"]);
    expect(board.top(2)).toHaveLength(2);
  });

  it("saves to its file and loads it back", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "br-board-")), "sub", "board.json");
    const board = new Leaderboard(file);
    board.record("Ada", { place: 1, kills: 2, damage: 10 });
    board.record("Bo", { place: 4, kills: 0, damage: 0 });
    await board.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
    expect(new Leaderboard(file).top(10)).toEqual(board.top(10));
  });
});
