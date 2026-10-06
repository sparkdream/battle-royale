import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import {
  GameState, MSG_INPUT, MSG_KILL, MSG_MATCH_END, MSG_STATS, type MatchEndMessage, PHASE_DROP,
  PHASE_ENDED, PHASE_LOBBY, PHASE_PLAYING, type StatsMessage, WEAPON_PISTOL,
} from "@br/shared";

// A fast match: short lobby and drop, zone at 10x speed. Env must be set
// before the room module loads, since it reads these at import time.
Object.assign(process.env, { LOBBY_SECONDS: "2", DROP_SECONDS: "2", MATCH_SPEED: "10", BOT_FILL: "8" });
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
      .joinOrCreate("battle", { name: "Tester", difficulty: "hard" }, GameState);
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
    await room.leave();
  });
});
