import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { MatchRecord } from "@br/shared";
import { ProfileStore, type MatchResult, mergeBoards, sanitizeRef } from "./profiles";

const token = (c: string) => c.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const result = (place: number, kills: number, extra: Partial<MatchResult> = {}): MatchResult =>
  ({ place, kills, damage: 0, survivedSeconds: 60, items: {}, crates: 0, ...extra });

describe("profiles", () => {
  it("creates a profile per token, once, and ignores malformed tokens", () => {
    const store = new ProfileStore(null);
    const a = store.profile(token("a"), "x")!;
    expect(a).toEqual({ id: expect.any(String), name: "" });
    expect(store.profile(token("a"), "other")).toEqual(a);
    expect(store.profile(token("b"), "")!.id).not.toBe(a.id);
    expect(store.profile("short", "")).toBeNull();
    expect(store.profile(undefined, "")).toBeNull();
    expect(store.profile(token("A"), "")).toBeNull(); // lowercase hex only
  });

  it("reserves names case-insensitively, and frees the old one on rename", () => {
    const store = new ProfileStore(null);
    const a = store.profile(token("a"), "")!;
    const b = store.profile(token("b"), "")!;
    expect(store.rename(a.id, "Ada")).toBe(true);
    expect(store.rename(b.id, "ada")).toBe(false);
    expect(store.nameTaken("ADA")).toBe(true);
    expect(store.nameTaken("ADA", a.id)).toBe(false);
    expect(store.rename(a.id, "ADA")).toBe(true); // their own name, new spelling
    expect(store.profile(token("a"), "")!.name).toBe("ADA");
    expect(store.rename(a.id, "Bo")).toBe(true);
    expect(store.rename(b.id, "Ada")).toBe(true);
  });

  it("adds up results and ranks named players by wins, then kills, then fewest matches", () => {
    const store = new ProfileStore(null);
    const named = (c: string, name: string) => {
      const p = store.profile(token(c), "")!;
      store.rename(p.id, name);
      return p.id;
    };
    const many = named("a", "Many kills");
    const winner = named("b", "Winner");
    const few = named("c", "Few kills");
    const slow = named("d", "Slow");
    const unnamed = store.profile(token("e"), "")!.id;
    store.record(many, result(2, 9));
    store.record(winner, result(1, 1, { damage: 10.4 }));
    store.record(few, result(2, 1));
    store.record(slow, result(2, 1));
    store.record(slow, result(5, 0));
    store.record(unnamed, result(1, 20));
    expect(store.top(10).map((e) => e.name)).toEqual(["Winner", "Many kills", "Few kills", "Slow"]);
    expect(store.top(10)[3]).toEqual(expect.objectContaining({ matches: 2, kills: 1, bestPlace: 2 }));
    expect(store.top(1)).toEqual([expect.objectContaining({ name: "Winner", wins: 1, damage: 10 })]);
  });

  it("reports each achievement once, when first earned", () => {
    const store = new ProfileStore(null);
    const id = store.profile(token("a"), "")!.id;
    const codes = (r: { code: string }[]) => r.map((a) => a.code);
    expect(codes(store.record(id, result(3, 0)))).toEqual(["dropped-in"]);
    expect(codes(store.record(id, result(1, 5)))).toEqual(["first-blood", "last-one-standing", "rampage", "gunslinger"]);
    expect(store.record(id, result(1, 6))).toEqual([]);
    expect(store.achievements(id)).toEqual(["dropped-in", "first-blood", "last-one-standing", "rampage", "gunslinger"].sort());
  });

  it("adds up items and crates across matches for the career achievements", () => {
    const store = new ProfileStore(null);
    const id = store.profile(token("a"), "")!.id;
    const codes = (r: { code: string }[]) => r.map((a) => a.code);
    store.record(id, result(3, 0, { items: { "1": 2, "2": 1 }, crates: 20 }));
    expect(codes(store.record(id, result(3, 0, { items: { "3": 1, "10": 96 }, crates: 5, survivedSeconds: 240 }))))
      .toEqual(["survivor", "collector", "packrat", "looter"]);
  });

  it("adds the newer columns to a file made by the first version", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "br-db-")), "game.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE profiles (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', name_key TEXT UNIQUE,
      ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, matches INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0, damage INTEGER NOT NULL DEFAULT 0,
      best_place INTEGER NOT NULL DEFAULT 0, last_played INTEGER NOT NULL DEFAULT 0)`);
    old.close();
    const store = new ProfileStore(file);
    const id = store.profile(token("a"), "")!.id;
    expect(store.record(id, result(2, 0, { crates: 25 })).map((a) => a.code)).toEqual(["dropped-in", "looter"]);
    store.close();
  });

  it("counts the funnel, overall and by ref", () => {
    const store = new ProfileStore(null);
    const now = Date.UTC(2026, 9, 9, 12);
    const x1 = store.profile(token("a"), "X!", now - 10 * DAY)!.id;
    const x2 = store.profile(token("b"), "x", now)!.id;
    store.profile(token("c"), "", now); // joined, never finished a match
    store.record(x1, result(4, 0), now - 10 * DAY);
    store.record(x1, result(2, 1), now - DAY);
    store.record(x2, result(9, 0), now);
    store.recordMatch(2, 8, now);
    store.recordMatch(1, 9, now - DAY);
    store.recordMatch(5, 5, now - 30 * DAY);
    expect(store.funnel(now)).toEqual({
      profiles: 3, played: 2, returning: 1, active7d: 2,
      byRef: [{ ref: "x", profiles: 2, played: 2, returning: 1 }, { ref: "", profiles: 1, played: 0, returning: 0 }],
      matches7d: 2, humansPerMatch7d: 1.5,
    });
  });

  it("keeps everything in its file across restarts", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "br-db-")), "sub", "game.db");
    const store = new ProfileStore(file);
    const id = store.profile(token("a"), "")!.id;
    store.rename(id, "Ada");
    store.record(id, result(1, 2, { damage: 10 }));
    const before = store.top(10);
    store.close();
    const reopened = new ProfileStore(file);
    expect(reopened.profile(token("a"), "")).toEqual({ id, name: "Ada" });
    expect(reopened.top(10)).toEqual(before);
    reopened.close();
  });

  it("merges the onchain board first; its names shadow local ones, case-insensitively", () => {
    const chain = [
      { name: "Ada", address: "sprkdrm1ada", wins: 3 },
      { name: "Grace", address: "sprkdrm1grace", wins: 2 },
    ];
    const local = [
      { name: "ada", wins: 0 },
      { name: "Bob", wins: 1 },
    ];
    expect(mergeBoards(chain, local, 50).map((r) => r.name)).toEqual(["Ada", "Grace", "Bob"]);
    expect(mergeBoards(chain, local, 2)).toHaveLength(2);
  });

  it("sanitizes refs", () => {
    expect(sanitizeRef("Guild-Night_2!")).toBe("guild-night_2");
    expect(sanitizeRef("x".repeat(40))).toHaveLength(32);
    expect(sanitizeRef(42)).toBe("");
  });

  it("stores a match record and serves back the exact bytes it hashed", () => {
    const store = new ProfileStore(null);
    const record: MatchRecord = {
      id: "0123456789abcdef", game: "battle-royale", map: { id: "m1", seed: 7 }, difficulty: "normal",
      startedAt: 1, endedAt: 2, humans: 1, bots: 0, winner: "Ada",
      players: [{ name: "Ada", bot: false, place: 1, kills: 0, damage: 0, survivedSeconds: 1, items: {}, crates: 0 }],
    };
    const hash = store.storeMatch(record);
    const body = store.matchRecord("0123456789abcdef")!;
    expect(JSON.parse(body)).toEqual(record);
    expect(createHash("sha256").update(body).digest("hex")).toBe(hash);
    expect(store.matchRecord("missing")).toBeNull();
  });
});
