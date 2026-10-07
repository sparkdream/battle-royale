import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LeaderboardEntry } from "@br/shared";

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/leaderboard.json");

/**
 * Lifetime results of human players, keyed by name (case-insensitive; there are
 * no accounts). Kept in memory and written to a JSON file after every change.
 */
export class Leaderboard {
  private entries = new Map<string, LeaderboardEntry>();
  private saving: Promise<void> | null = null;
  private dirty = false;

  /** `file` null: memory only. */
  constructor(private readonly file: string | null) {
    if (file) this.load(file);
  }

  record(name: string, result: { place: number; kills: number; damage: number }) {
    const key = name.toLowerCase();
    const e = this.entries.get(key) ?? { name, matches: 0, wins: 0, kills: 0, damage: 0, bestPlace: 0, lastPlayed: 0 };
    e.name = name; // latest spelling
    e.matches++;
    if (result.place === 1) e.wins++;
    e.kills += result.kills;
    e.damage += Math.round(result.damage);
    e.bestPlace = e.bestPlace === 0 ? result.place : Math.min(e.bestPlace, result.place);
    e.lastPlayed = Date.now();
    this.entries.set(key, e);
    this.save();
  }

  /** Most wins first, then most kills, then fewest matches. */
  top(limit: number): LeaderboardEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.matches - b.matches)
      .slice(0, limit);
  }

  /** Resolves once everything recorded so far is on disk. */
  async flush() {
    while (this.saving) await this.saving;
  }

  private load(file: string) {
    try {
      const list = JSON.parse(readFileSync(file, "utf8")) as LeaderboardEntry[];
      for (const e of list) this.entries.set(e.name.toLowerCase(), e);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Could not read ${file}:`, err);
      // Fail early on an unwritable location rather than after the first match.
      mkdirSync(path.dirname(file), { recursive: true });
    }
  }

  /** Coalesces writes; each one goes to a temp file first so a crash can't leave half a file. */
  private save() {
    if (!this.file) return;
    this.dirty = true;
    this.saving ??= this.write(this.file).finally(() => (this.saving = null));
  }

  private async write(file: string) {
    while (this.dirty) {
      this.dirty = false;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(this.top(Infinity), null, 1));
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.error(`Could not save ${file}:`, err);
      }
    }
  }
}

// LEADERBOARD_FILE="" keeps it in memory only (tests).
const file = process.env.LEADERBOARD_FILE ?? DEFAULT_FILE;
export const leaderboard = new Leaderboard(file || null);
