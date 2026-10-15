import { WEAPON_RIFLE, WEAPON_SHOTGUN, WEAPON_SMG } from "./weapons";

/** Items picked up, by loot type ("1" SMG … "3" rifle, "10" medkit … "12" ammo). */
export type ItemCounts = Record<string, number>;

/** A player's lifetime totals, after the match that just ended. */
export interface CareerTotals {
  matches: number;
  wins: number;
  kills: number;
  /** Crates broken. */
  crates: number;
  items: ItemCounts;
}

/** The match that just ended. */
export interface MatchOutcome {
  place: number;
  kills: number;
  survivedSeconds: number;
}

export interface Achievement {
  /** Stable id: stored per profile, and onchain as the `achievement` attribute of its badge. */
  code: string;
  title: string;
  description: string;
  earned: (totals: CareerTotals, match: MatchOutcome) => boolean;
}

/**
 * Milestones the server records per profile (with a notice when earned) and,
 * for a player with a linked wallet, mints as soulbound badges. Codes are
 * stored, so never rename one; add new ones instead.
 */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { code: "dropped-in", title: "Dropped in", description: "Finish your first match", earned: (t) => t.matches >= 1 },
  { code: "first-blood", title: "First blood", description: "Eliminate another player", earned: (t) => t.kills >= 1 },
  { code: "last-one-standing", title: "Last one standing", description: "Win a match", earned: (t) => t.wins >= 1 },
  { code: "rampage", title: "Rampage", description: "Get 5 eliminations in one match", earned: (_t, m) => m.kills >= 5 },
  { code: "gunslinger", title: "Gunslinger", description: "Win a match with 5 or more eliminations", earned: (_t, m) => m.place === 1 && m.kills >= 5 },
  { code: "sharpshooter", title: "Sharpshooter", description: "Get 10 eliminations in one match", earned: (_t, m) => m.kills >= 10 },
  { code: "survivor", title: "Survivor", description: "Stay alive for 4 minutes in one match", earned: (_t, m) => m.survivedSeconds >= 240 },
  {
    code: "collector", title: "Collector", description: "Pick up an SMG, a shotgun and a rifle",
    earned: (t) => [WEAPON_SMG, WEAPON_SHOTGUN, WEAPON_RIFLE].every((type) => (t.items[String(type)] ?? 0) > 0),
  },
  { code: "packrat", title: "Packrat", description: "Pick up 100 items", earned: (t) => totalItems(t.items) >= 100 },
  { code: "looter", title: "Looter", description: "Break 25 crates", earned: (t) => t.crates >= 25 },
  { code: "big-game-hunter", title: "Big game hunter", description: "Reach 100 eliminations", earned: (t) => t.kills >= 100 },
  { code: "veteran", title: "Veteran", description: "Finish 25 matches", earned: (t) => t.matches >= 25 },
  { code: "champion", title: "Champion", description: "Win 10 matches", earned: (t) => t.wins >= 10 },
];

const BY_CODE = new Map(ACHIEVEMENTS.map((a) => [a.code, a]));

export function achievementByCode(code: string): Achievement | undefined {
  return BY_CODE.get(code);
}

/** What this match earns that isn't in `already`, in list order. `totals` include the match. */
export function newAchievements(totals: CareerTotals, match: MatchOutcome, already: readonly string[]): Achievement[] {
  return ACHIEVEMENTS.filter((a) => !already.includes(a.code) && a.earned(totals, match));
}

export function totalItems(items: ItemCounts): number {
  let n = 0;
  for (const count of Object.values(items)) n += count;
  return n;
}
