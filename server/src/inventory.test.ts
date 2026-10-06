import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import {
  GameState, KEY_DOWN, KEY_INTERACT, KEY_JUMP, KEY_LEFT, KEY_RELOAD, KEY_RIGHT, KEY_UP, MSG_INPUT,
  PHASE_DROP, PHASE_PLAYING, WEAPONS, WEAPON_NONE, WEAPON_PISTOL, isWeaponLoot, magIn,
} from "@br/shared";

// An empty map and no bots, so a client can walk straight to loot.
Object.assign(process.env, {
  LOBBY_SECONDS: "1", DROP_SECONDS: "1", BOT_FILL: "0", OBSTACLE_COUNT: "0", BUILDING_COUNT: "0",
  POND_COUNT: "0", BUSH_COUNT: "0", CRATE_COUNT: "0", LOOT_COUNT: "60",
});
const PORT = 26670 + Math.floor(Math.random() * 1000);
const url = `http://localhost:${PORT}`;

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

describe("inventory over the network", () => {
  it("picks up a weapon, fires, reloads and switches slots", { timeout: 60_000 }, async () => {
    // Two humans so the match starts; the second just stands there.
    const room: Room<any, GameState> = await new Client(url).joinOrCreate("battle", { name: "A" }, GameState);
    const other = await new Client(url).joinOrCreate("battle", { name: "B" }, GameState);
    room.onMessage("*", () => {});
    other.onMessage("*", () => {});
    let seq = 0;
    const send = (keys: number, extra: { fire?: boolean; slot?: number; angle?: number } = {}) =>
      room.send(MSG_INPUT, { seq: ++seq, keys, angle: extra.angle ?? 0, fire: extra.fire ?? false, slot: extra.slot ?? me().slot });
    const me = () => room.state.players.get(room.sessionId)!;
    const phase = (): string => room.state.phase;

    while (phase() !== PHASE_DROP) await sleep(50);
    send(KEY_JUMP);
    send(0);
    while (me().inPlane) await sleep(50);

    // Walk to the nearest weapon lying around.
    const nearest = () => {
      let best: { x: number; y: number; type: number } | null = null;
      room.state.loot.forEach((l) => {
        if (!isWeaponLoot(l.type)) return;
        if (!best || Math.hypot(l.x - me().x, l.y - me().y) < Math.hypot(best.x - me().x, best.y - me().y)) best = l;
      });
      return best!;
    };
    const target = nearest();
    for (let i = 0; i < 600 && Math.hypot(target.x - me().x, target.y - me().y) > 12; i++) {
      const dx = target.x - me().x;
      const dy = target.y - me().y;
      send((dx > 6 ? KEY_RIGHT : dx < -6 ? KEY_LEFT : 0) | (dy > 6 ? KEY_DOWN : dy < -6 ? KEY_UP : 0));
      await sleep(33);
    }
    send(KEY_INTERACT);
    send(0);
    await sleep(300);
    expect(me().w1).toBe(target.type);
    expect(me().slot).toBe(1);
    expect(magIn(me(), 1)).toBe(WEAPONS[target.type].mag);

    // Wait out the start of the match (no shooting during the drop is fine too), then fire a few rounds.
    while (phase() !== PHASE_PLAYING) await sleep(50);
    const before = magIn(me(), 1);
    for (let i = 0; i < 40 && magIn(me(), 1) === before; i++) {
      send(0, { fire: true, angle: Math.PI / 2 });
      await sleep(33);
    }
    send(0);
    await sleep(200);
    expect(magIn(me(), 1)).toBeLessThan(before);

    send(KEY_RELOAD);
    send(0);
    await sleep(200);
    expect(me().reloading).toBe(true);
    await sleep(WEAPONS[target.type].reloadTicks * 34 + 300);
    expect(me().reloading).toBe(false);
    expect(magIn(me(), 1)).toBe(WEAPONS[target.type].mag);

    send(0, { slot: 0 });
    await sleep(200);
    expect(me().slot).toBe(0);
    expect(me().w0).toBe(WEAPON_PISTOL);
    expect(me().w1).not.toBe(WEAPON_NONE);

    await room.leave();
    await other.leave();
  });
});
