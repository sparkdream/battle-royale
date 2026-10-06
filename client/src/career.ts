import type { StatsMessage } from "@br/shared";

const KEY = "career";

/** Lifetime stats, kept in this browser only. */
export interface Career {
  games: number;
  wins: number;
  kills: number;
  bestPlace: number;
}

export function loadCareer(): Career {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { games: 0, wins: 0, kills: 0, bestPlace: 0, ...JSON.parse(raw) };
  } catch {
    // Unavailable or corrupt storage: start over.
  }
  return { games: 0, wins: 0, kills: 0, bestPlace: 0 };
}

export function recordMatch(stats: StatsMessage): Career {
  const c = loadCareer();
  c.games++;
  c.kills += stats.kills;
  if (stats.place === 1) c.wins++;
  if (c.bestPlace === 0 || stats.place < c.bestPlace) c.bestPlace = stats.place;
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Private mode etc.: the stats just won't persist.
  }
  return c;
}

export function describeCareer(c: Career): string {
  if (c.games === 0) return "";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(c.games, "match")} · ${plural(c.wins, "win")} · ${plural(c.kills, "kill")} · best #${c.bestPlace}`;
}
