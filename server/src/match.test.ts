import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Funnel } from "./profiles";
import { Client, type Room } from "@colyseus/sdk";
import {
  ERR_SERVER_FULL, GameState, LEADERBOARD_PATH, type LeaderboardEntry, MATCH_RECORD_PATH, type MatchRecord, MSG_INPUT, MSG_KILL, MSG_MATCH_END, MSG_NOTICE, MSG_SETTINGS, MSG_SPECTATE, MSG_STATS, type MatchEndMessage, PHASE_DROP,
  PHASE_ENDED, PHASE_LOBBY, PHASE_PLAYING, type SpectateMessage, type StatsMessage, WEAPON_PISTOL,
} from "@br/shared";

// A fast match: short lobby and drop, zone at 10x speed. Env must be set
// before the room module loads, since it reads these at import time.
// DB_FILE="": keep profiles and the leaderboard in memory. ADMIN_TOKEN turns on the funnel route.
Object.assign(process.env, {
  LOBBY_SECONDS: "2", DROP_SECONDS: "2", MATCH_SPEED: "10", BOT_FILL: "8", DB_FILE: "", MAX_ROOMS: "3", ADMIN_TOKEN: "secret",
});
const PORT = 25670 + Math.floor(Math.random() * 1000);

let server: { gracefullyShutdown: (exit?: boolean) => Promise<void> };

beforeAll(async () => {
  const { createServer } = await import("./app");
  const s = createServer();
  await s.listen(PORT);
  server = s;
});

afterAll(async () => {
  await server?.gracefullyShutdown(false);
});

/** A guest-profile token, as a browser would generate. */
const token = (c: string) => c.repeat(64);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await sleep(50);
  }
}

describe("a full match against bots", () => {
  it("runs lobby → drop → playing → ended → lobby", { timeout: 120_000 }, async () => {
    const room: Room<any, GameState> = await new Client(`http://localhost:${PORT}`)
      .joinOrCreate("battle", { name: "Tester", difficulty: "hard", profile: token("1"), ref: "x" }, GameState);
    const phases: string[] = [];
    let sawPartialView = false;
    let botsArmed = false;
    let stats: StatsMessage | null = null;
    let end: MatchEndMessage | null = null;
    const kills: unknown[] = [];
    room.onMessage(MSG_STATS, (m: StatsMessage) => (stats = m));
    room.onMessage(MSG_MATCH_END, (m: MatchEndMessage) => (end = m));
    room.onMessage(MSG_KILL, (m) => kills.push(m));
    room.onMessage("*", () => {});
    room.onStateChange((s) => {
      if (phases.at(-1) !== s.phase) phases.push(s.phase);
      if (s.playerCount > 0 && s.players.size < s.playerCount) sawPartialView = true;
      s.players.forEach((p) => {
        if (p.bot && (p.w0 !== WEAPON_PISTOL || p.w1 !== 255)) botsArmed = true;
      });
    });

    await until(() => room.state.phase === PHASE_LOBBY && room.state.playerCount > 0, 5000);
    expect(room.state.playerCount).toBe(8); // BOT_FILL counts the human too
    expect(room.state.difficulty).toBe("hard");

    // Jump out of the plane straight away, then stand still and get eliminated eventually.
    await until(() => room.state.phase === PHASE_DROP, 10_000);
    let seq = 0;
    room.send(MSG_INPUT, { seq: ++seq, keys: 128, angle: 0, fire: false, slot: 0 });
    room.send(MSG_INPUT, { seq: ++seq, keys: 0, angle: 0, fire: false, slot: 0 });

    await until(() => end !== null && room.state.phase === PHASE_LOBBY, 100_000);

    expect(phases).toEqual([PHASE_LOBBY, PHASE_DROP, PHASE_PLAYING, PHASE_ENDED, PHASE_LOBBY]);
    // Line of sight: players out of view weren't sent to us.
    expect(sawPartialView).toBe(true);
    expect(kills.length).toBeGreaterThan(0);
    expect(botsArmed).toBe(true);
    expect(stats).not.toBeNull();
    expect(stats!.place).toBeGreaterThanOrEqual(1);
    expect(end!.leaderboard.length).toBeGreaterThan(0);

    // Only the named human is on the server's leaderboard.
    const board = await (await fetch(`http://localhost:${PORT}${LEADERBOARD_PATH}`)).json() as LeaderboardEntry[];
    expect(board).toEqual([expect.objectContaining({ name: "Tester", matches: 1, bestPlace: stats!.place })]);

    // The match record is served verbatim, with everyone's result in it.
    expect(end!.matchId).toMatch(/^[0-9a-f]{16}$/);
    const recordUrl = `http://localhost:${PORT}${MATCH_RECORD_PATH}/${end!.matchId}`;
    const record = await (await fetch(recordUrl)).json() as MatchRecord;
    expect(record).toEqual(expect.objectContaining({ id: end!.matchId, game: "battle-royale", humans: 1, winner: end!.winner }));
    expect(record.players.map((p) => p.place)).toEqual([...record.players.map((p) => p.place)].sort((a, b) => a - b));
    expect(record.players).toContainEqual(expect.objectContaining({ name: "Tester", bot: false, place: stats!.place }));
    expect(record.players.some((p) => p.bot)).toBe(true);
    expect((await fetch(`http://localhost:${PORT}${MATCH_RECORD_PATH}/ffffffffffffffff`)).status).toBe(404);

    // The funnel counts them under their ref, and only for the operator.
    const funnelUrl = `http://localhost:${PORT}/admin/funnel`;
    expect((await fetch(funnelUrl)).status).toBe(401);
    const funnel = await (await fetch(funnelUrl, { headers: { Authorization: "Bearer secret" } })).json() as Funnel;
    expect(funnel).toEqual(expect.objectContaining({ played: 1, matches7d: 1, humansPerMatch7d: 1 }));
    expect(funnel.byRef).toContainEqual({ ref: "x", profiles: 1, played: 1, returning: 0 });
    await room.leave();
  });
});

describe("guest profiles", () => {
  it("reserves a name for the profile that took it", { timeout: 15_000 }, async () => {
    const client = new Client(`http://localhost:${PORT}`);
    const owner: Room<any, GameState> = await client.joinOrCreate("battle", { name: "Phoenix", profile: token("2") }, GameState);
    owner.onMessage("*", () => {});
    await until(() => owner.state.players.get(owner.sessionId) !== undefined, 5000);
    expect(owner.state.players.get(owner.sessionId)!.name).toBe("Phoenix");

    // Someone else (with or without a profile) can't use it, in any spelling.
    for (const profile of [token("3"), undefined]) {
      const notices: string[] = [];
      const other: Room<any, GameState> = await client.joinOrCreate("battle", { name: "phoenix", profile }, GameState);
      other.onMessage(MSG_NOTICE, (m: string) => notices.push(m));
      other.onMessage("*", () => {});
      await until(() => other.state.players.get(other.sessionId) !== undefined && notices.length > 0, 5000);
      expect(notices[0]).toBe("The name phoenix is taken");
      expect(other.state.players.get(other.sessionId)!.name).toMatch(/^Player \d+$/);
      await other.leave();
    }

    // The owner gets it back next time even without typing it.
    await owner.leave();
    const back: Room<any, GameState> = await client.joinOrCreate("battle", { profile: token("2") }, GameState);
    back.onMessage("*", () => {});
    await until(() => back.state.players.get(back.sessionId) !== undefined, 5000);
    expect(back.state.players.get(back.sessionId)!.name).toBe("Phoenix");
    await back.leave();
  });
});

describe("joining a match in progress", () => {
  it("puts late joiners in the same room as spectators", { timeout: 30_000 }, async () => {
    const client = new Client(`http://localhost:${PORT}`);
    const first: Room<any, GameState> = await client.joinOrCreate("battle", { name: "First", difficulty: "easy" }, GameState);
    await until(() => first.state.phase === PHASE_DROP, 10_000);

    const late: Room<any, GameState> = await client.joinOrCreate("battle", { name: "Late", difficulty: "easy" }, GameState);
    let watching: SpectateMessage | null = null;
    late.onMessage(MSG_SPECTATE, (m: SpectateMessage) => (watching = m));
    late.onMessage("*", () => {});
    expect(late.roomId).toBe(first.roomId);
    await until(() => late.state.players.get(late.sessionId) !== undefined && watching !== null, 5000);
    expect(late.state.players.get(late.sessionId)!.alive).toBe(false);
    expect(watching!.id).not.toBe("");

    // The in-game menu: a rename shows at once; new bot difficulty is for everyone, from the next match.
    const notices: string[] = [];
    first.onMessage(MSG_NOTICE, (m: string) => notices.push(m));
    late.send(MSG_SETTINGS, { name: "Renamed", difficulty: "hard" });
    await until(() => first.state.difficulty === "hard" && notices.length > 0, 5000);
    expect(notices[0]).toBe("Renamed set the bots to hard from the next match");
    expect(late.state.players.get(late.sessionId)!.name).toBe("Renamed");

    // "Play again" mid-match asks for a room of its own.
    const fresh: Room<any, GameState> = await client.create("battle", { name: "Fresh", difficulty: "easy" }, GameState);
    fresh.onMessage("*", () => {});
    expect(fresh.roomId).not.toBe(first.roomId);

    await Promise.all([first.leave(), late.leave(), fresh.leave()]);
  });
});

describe("spectators", () => {
  it("watch without being counted, and can switch to playing", { timeout: 30_000 }, async () => {
    const client = new Client(`http://localhost:${PORT}`);
    const watcher: Room<any, GameState> = await client.joinOrCreate("battle", { name: "Watcher", spectate: true }, GameState);
    let watching: SpectateMessage | null = null;
    watcher.onMessage(MSG_SPECTATE, (m: SpectateMessage) => (watching = m));
    watcher.onMessage("*", () => {});
    const me = () => watcher.state.players.get(watcher.sessionId)!;

    // On their own, a bots-only match to watch, starting in the lobby.
    await until(() => watcher.state.phase === PHASE_LOBBY && watcher.state.playerCount > 0 && watching !== null, 5000);
    expect(watcher.state.playerCount).toBe(8); // all bots: the spectator isn't counted
    expect(me().spectator).toBe(true);
    expect(me().alive).toBe(false);

    // Switching to playing in the lobby takes a bot's place at once.
    watcher.send(MSG_SETTINGS, { spectate: false });
    await until(() => me().alive, 5000);
    expect(me().spectator).toBe(false);
    expect(watcher.state.playerCount).toBe(8);

    // But no bowing out while alive in a match.
    await until(() => watcher.state.phase === PHASE_DROP, 10_000);
    watcher.send(MSG_SETTINGS, { spectate: true });
    await sleep(300);
    expect(me().spectator).toBe(false);
    expect(me().alive).toBe(true);

    await watcher.leave();
  });
});

describe("room limit", () => {
  it("refuses new games past MAX_ROOMS but still lets people join", { timeout: 15_000 }, async () => {
    const client = new Client(`http://localhost:${PORT}`);
    const rooms: Room<any, GameState>[] = [];
    let refused: { code?: number } | null = null;
    // Earlier tests' rooms may still be closing, so don't assume how many exist.
    for (let i = 0; i < 4 && !refused; i++) {
      try {
        const room = await client.create("battle", { name: `Host${i}` }, GameState);
        room.onMessage("*", () => {});
        rooms.push(room);
      } catch (err) {
        refused = err as { code?: number };
      }
    }
    expect(refused?.code).toBe(ERR_SERVER_FULL);

    // joinOrCreate finds a room with space instead of making one.
    const joined = await client.joinOrCreate("battle", { name: "Joiner" }, GameState);
    joined.onMessage("*", () => {});
    expect(rooms.map((r) => r.roomId)).toContain(joined.roomId);

    await Promise.all([...rooms, joined].map((r) => r.leave()));
  });
});
