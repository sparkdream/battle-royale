import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ACHIEVEMENTS, type Achievement, type ItemCounts, type LeaderboardEntry, type MatchRecord, PROFILE_TOKEN_PATTERN,
} from "@br/shared";
import { encodeMatchRecord } from "./matchRecord";

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/game.db");
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Profile {
  /** Public id; the secret token is never stored, only its hash. */
  id: string;
  /** "" until the player picks a name. */
  name: string;
}

export interface MatchResult {
  place: number;
  kills: number;
  damage: number;
  survivedSeconds: number;
  /** Items picked up this match, by loot type. */
  items: ItemCounts;
  /** Crates broken this match. */
  crates: number;
}

/** Counts for each step of the player funnel, overall and by `ref`. */
export interface Funnel {
  /** Profiles created: browsers that joined at least once. */
  profiles: number;
  /** Profiles that finished at least one match. */
  played: number;
  /** Profiles that played on two or more different days (UTC). */
  returning: number;
  /** Profiles that played in the last 7 days. */
  active7d: number;
  byRef: { ref: string; profiles: number; played: number; returning: number }[];
  /** Matches with at least one human that ended in the last 7 days. */
  matches7d: number;
  /** Average humans per match over those matches. */
  humansPerMatch7d: number;
}

/**
 * Guest profiles: one per browser, identified by a secret token the client
 * generates. Holds lifetime results (the leaderboard), reserved names, earned
 * achievements, first-visit `ref`, and the per-day play log the funnel counts.
 * SQLite through node:sqlite, so no native dependency. All calls are
 * synchronous and small (a few rows per finished match).
 */
export class ProfileStore {
  private db: DatabaseSync;

  /** `file` null: memory only. */
  constructor(file: string | null) {
    if (file) mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file ?? ":memory:");
    if (file) this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id          TEXT PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL DEFAULT '',
        name_key    TEXT UNIQUE,              -- lower(name); NULL while unnamed
        ref         TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        matches     INTEGER NOT NULL DEFAULT 0,
        wins        INTEGER NOT NULL DEFAULT 0,
        kills       INTEGER NOT NULL DEFAULT 0,
        damage      INTEGER NOT NULL DEFAULT 0,
        best_place  INTEGER NOT NULL DEFAULT 0,
        last_played INTEGER NOT NULL DEFAULT 0,
        crates      INTEGER NOT NULL DEFAULT 0,
        items       TEXT NOT NULL DEFAULT '{}'  -- ItemCounts as JSON
      );
      CREATE TABLE IF NOT EXISTS play_days (
        profile_id TEXT NOT NULL,
        day        TEXT NOT NULL,             -- YYYY-MM-DD, UTC
        PRIMARY KEY (profile_id, day)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS achievements (
        profile_id TEXT NOT NULL,
        code       TEXT NOT NULL,
        earned_at  INTEGER NOT NULL,
        PRIMARY KEY (profile_id, code)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS matches (
        id       INTEGER PRIMARY KEY,
        ended_at INTEGER NOT NULL,
        humans   INTEGER NOT NULL,
        bots     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_records (
        id       TEXT PRIMARY KEY,           -- MatchRecord.id
        ended_at INTEGER NOT NULL,           -- unix ms
        hash     TEXT NOT NULL,              -- sha256 of body, what the match token carries
        body     TEXT NOT NULL               -- the record's exact JSON bytes
      );
    `);
    // Columns added after the first version of the table.
    const columns = new Set((this.db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("crates")) this.db.exec("ALTER TABLE profiles ADD COLUMN crates INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("items")) this.db.exec("ALTER TABLE profiles ADD COLUMN items TEXT NOT NULL DEFAULT '{}'");
  }

  /** The profile for this token, created on first sight. null for a missing or malformed token. */
  profile(token: unknown, ref: unknown, now = Date.now()): Profile | null {
    if (typeof token !== "string" || !PROFILE_TOKEN_PATTERN.test(token)) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    const found = this.db.prepare("SELECT id, name FROM profiles WHERE token_hash = ?").get(hash) as Profile | undefined;
    if (found) return { id: found.id, name: found.name };
    const id = randomBytes(6).toString("base64url");
    this.db.prepare("INSERT INTO profiles (id, token_hash, ref, created_at) VALUES (?, ?, ?, ?)")
      .run(id, hash, sanitizeRef(ref), now);
    return { id, name: "" };
  }

  /** Whether another profile holds this name (case-insensitive). */
  nameTaken(name: string, exceptId = ""): boolean {
    const row = this.db.prepare("SELECT id FROM profiles WHERE name_key = ?").get(name.toLowerCase()) as { id: string } | undefined;
    return !!row && row.id !== exceptId;
  }

  /** Gives the profile this name, releasing its old one. false if another profile holds it. */
  rename(id: string, name: string): boolean {
    if (!name || this.nameTaken(name, id)) return false;
    this.db.prepare("UPDATE profiles SET name = ?, name_key = ? WHERE id = ?").run(name, name.toLowerCase(), id);
    return true;
  }

  /** Adds a finished match to the profile. Returns the achievements it earned for the first time. */
  record(id: string, result: MatchResult, now = Date.now()): Achievement[] {
    const earned: Achievement[] = [];
    this.transaction(() => {
      const row = this.db.prepare("SELECT items FROM profiles WHERE id = ?").get(id) as { items: string } | undefined;
      if (!row) return;
      const items: ItemCounts = JSON.parse(row.items);
      for (const [type, n] of Object.entries(result.items)) items[type] = (items[type] ?? 0) + n;
      this.db.prepare(`
        UPDATE profiles SET
          matches = matches + 1,
          wins = wins + ?,
          kills = kills + ?,
          damage = damage + ?,
          best_place = CASE WHEN best_place = 0 THEN ? ELSE MIN(best_place, ?) END,
          last_played = ?,
          crates = crates + ?,
          items = ?
        WHERE id = ?
      `).run(
        result.place === 1 ? 1 : 0, result.kills, Math.round(result.damage), result.place, result.place, now,
        result.crates, JSON.stringify(items), id,
      );
      this.db.prepare("INSERT OR IGNORE INTO play_days (profile_id, day) VALUES (?, ?)").run(id, utcDay(now));

      const totals = this.db.prepare("SELECT matches, wins, kills, crates FROM profiles WHERE id = ?")
        .get(id) as { matches: number; wins: number; kills: number; crates: number };
      const insert = this.db.prepare("INSERT OR IGNORE INTO achievements (profile_id, code, earned_at) VALUES (?, ?, ?)");
      for (const a of ACHIEVEMENTS) {
        if (a.earned({ ...totals, items }, result) && insert.run(id, a.code, now).changes > 0) earned.push(a);
      }
    });
    return earned;
  }

  /** Codes of the achievements this profile has earned. */
  achievements(id: string): string[] {
    return (this.db.prepare("SELECT code FROM achievements WHERE profile_id = ? ORDER BY earned_at, code").all(id) as { code: string }[])
      .map((r) => r.code);
  }

  /** A match that had at least one human in it ended. */
  recordMatch(humans: number, bots: number, now = Date.now()) {
    this.db.prepare("INSERT INTO matches (ended_at, humans, bots) VALUES (?, ?, ?)").run(now, humans, bots);
  }

  /** Keep a match's full result for GET /matches/<id>. Returns its sha256. */
  storeMatch(record: MatchRecord, now = Date.now()): string {
    const { body, hash } = encodeMatchRecord(record);
    this.db.prepare("INSERT OR REPLACE INTO match_records (id, ended_at, hash, body) VALUES (?, ?, ?, ?)")
      .run(record.id, now, hash, body);
    return hash;
  }

  /** The stored record's exact bytes, to serve as-is (they're what was hashed). */
  matchRecord(id: string): string | null {
    const row = this.db.prepare("SELECT body FROM match_records WHERE id = ?").get(id) as { body: string } | undefined;
    return row?.body ?? null;
  }

  /** Named players only. Most wins first, then most kills, then fewest matches. */
  top(limit: number): LeaderboardEntry[] {
    return this.db.prepare(`
      SELECT name, matches, wins, kills, damage, best_place AS bestPlace, last_played AS lastPlayed
      FROM profiles WHERE name_key IS NOT NULL AND matches > 0
      ORDER BY wins DESC, kills DESC, matches ASC
      LIMIT ?
    `).all(limit) as unknown as LeaderboardEntry[];
  }

  funnel(now = Date.now()): Funnel {
    const since = now - 7 * DAY_MS;
    const count = (sql: string, ...params: (string | number)[]) =>
      Number((this.db.prepare(sql).get(...params) as { n: number }).n);
    const returningIds = "SELECT profile_id FROM play_days GROUP BY profile_id HAVING COUNT(*) >= 2";
    const byRef = this.db.prepare(`
      SELECT ref,
             COUNT(*) AS profiles,
             SUM(matches > 0) AS played,
             SUM(id IN (${returningIds})) AS returners
      FROM profiles GROUP BY ref ORDER BY profiles DESC
    `).all() as { ref: string; profiles: number; played: number; returners: number }[];
    const recent = this.db.prepare("SELECT COUNT(*) AS n, AVG(humans) AS avg FROM matches WHERE ended_at >= ?")
      .get(since) as { n: number; avg: number | null };
    return {
      profiles: count("SELECT COUNT(*) AS n FROM profiles"),
      played: count("SELECT COUNT(*) AS n FROM profiles WHERE matches > 0"),
      returning: count(`SELECT COUNT(*) AS n FROM (${returningIds})`),
      active7d: count("SELECT COUNT(DISTINCT profile_id) AS n FROM play_days WHERE day >= ?", utcDay(since)),
      byRef: byRef.map((r) => ({ ref: r.ref, profiles: r.profiles, played: Number(r.played), returning: Number(r.returners) })),
      matches7d: recent.n,
      humansPerMatch7d: recent.avg === null ? 0 : Math.round(recent.avg * 100) / 100,
    };
  }

  close() {
    this.db.close();
  }

  private transaction(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * The onchain leaderboard's rows first, then local ones whose name isn't on
 * one (an address outranks a name). A player with a linked wallet has the
 * same name in both, so this also keeps them from showing up twice.
 */
export function mergeBoards<T extends { name: string }, L extends { name: string }>(chain: T[], local: L[], limit: number): (T | L)[] {
  const claimed = new Set(chain.map((row) => row.name.toLowerCase()));
  return [...chain, ...local.filter((e) => !claimed.has(e.name.toLowerCase()))].slice(0, limit);
}

/** Lowercase letters, digits, `-` and `_`, at most 32 characters; anything else is dropped. */
export function sanitizeRef(ref: unknown): string {
  if (typeof ref !== "string") return "";
  return ref.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// DB_FILE="" keeps everything in memory only (tests).
const file = process.env.DB_FILE ?? DEFAULT_FILE;
export const profiles = new ProfileStore(file || null);
