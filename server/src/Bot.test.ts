import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSH_REVEAL_RANGE, GameState, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP, MAP_SIZE, PHASE_DROP, PHASE_PLAYING, Player,
  TICK_RATE, WEAPONS, WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN, WEAPON_SMG, emptyGeometry, stepPlayer,
} from "@br/shared";
import { Bot, type BotWorld, type Personality, SKILL } from "./Bot";
import { generateMap } from "./map";

/** Unit direction a set of movement keys points in (0, 0 when standing still). */
function heading(keys: number) {
  const x = (keys & KEY_RIGHT ? 1 : 0) - (keys & KEY_LEFT ? 1 : 0);
  const y = (keys & KEY_DOWN ? 1 : 0) - (keys & KEY_UP ? 1 : 0);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

describe("bot steering", () => {
  it("goes around a rock in the way instead of dithering in front of it", () => {
    // Bots are random (strafing, aim), so try many times. A strafe that turns back
    // at cover is fine; back, forth and back again within half a second is the jitter.
    const rapid = TICK_RATE / 2;
    for (let trial = 0; trial < 40; trial++) {
      // The target is straight behind a rock: visible, but no clear shot, so the bot heads for it.
      const state = new GameState();
      const geo = { ...emptyGeometry(), rocks: [{ x: 1000, y: 1000, r: 60 }] };
      const self = new Player({ x: 900, y: 1000 });
      state.players.set("bot", self);
      state.players.set("target", new Player({ x: 1250, y: 1000 }));
      const world: BotWorld = {
        tick: 0, phase: PHASE_DROP, players: state.players, loot: state.loot, geo, zone: state.zone, plane: state.plane,
      };
      const bot = new Bot("bot", SKILL.normal, "aggressive");

      const reversals: number[] = [];
      let prev = { x: 0, y: 0 };
      for (let tick = 1; tick <= 3 * TICK_RATE; tick++) {
        world.tick = tick;
        const { keys } = bot.think(self, world);
        const h = heading(keys);
        // A turn of more than 90° from one tick to the next.
        if (h.x * prev.x + h.y * prev.y < 0) reversals.push(tick);
        prev = h;
        stepPlayer(self, keys, geo);
      }
      const jitter = reversals.filter((t, i) => i > 1 && t - reversals[i - 2] < rapid);
      expect(jitter, `reversals at ticks ${reversals.join(", ")}`).toEqual([]);
    }
  });

  it("doesn't jitter when two bots fight on a real map", () => {
    // Rocks and walls at the edge of a shot used to flip bots between strafing sides,
    // or between closing in and backing off, several times a second.
    let ids = 0;
    let fightTicks = 0;
    let reversals = 0;
    let aimSnaps = 0;
    for (let trial = 0; trial < 12; trial++) {
      const state = new GameState();
      const { geo } = generateMap(state, { rocks: 110, buildings: 10, ponds: 6, bushes: 45, crates: 35 }, () => `m${ids++}`);
      Object.assign(state.zone, { x: MAP_SIZE / 2, y: MAP_SIZE / 2, tx: MAP_SIZE / 2, ty: MAP_SIZE / 2, r: MAP_SIZE, tr: MAP_SIZE });
      const world: BotWorld = {
        tick: 0, phase: PHASE_PLAYING, players: state.players, loot: state.loot, geo, zone: state.zone, plane: state.plane,
      };
      const x = 500 + Math.random() * (MAP_SIZE - 1000);
      const y = 500 + Math.random() * (MAP_SIZE - 1000);
      const fighters = [0, 1].map((i) => {
        const p = new Player({ x: x + i * 300, y });
        p.w0 = [WEAPON_PISTOL, WEAPON_SMG, WEAPON_RIFLE, WEAPON_SHOTGUN][(trial + i) % 4];
        p.mag0 = 200;
        p.res0 = 999;
        p.hp = 1e6; // nobody dies, so the fight goes on
        state.players.set(`b${i}`, p);
        const personalities: Personality[] = ["aggressive", "balanced", "camper", "looter"];
        return { p, bot: new Bot(`b${i}`, SKILL.normal, personalities[(trial + 2 * i) % 4]), prev: null as null | { x: number; y: number; angle: number } };
      });
      for (let tick = 1; tick <= 10 * TICK_RATE; tick++) {
        world.tick = tick;
        for (const f of fighters) {
          const input = f.bot.think(f.p, world);
          stepPlayer(f.p, input.keys, geo);
          const h = heading(input.keys);
          const fighting = (f.bot as unknown as { targetId: string | null }).targetId !== null;
          if (fighting && f.prev) {
            fightTicks++;
            if (h.x * f.prev.x + h.y * f.prev.y < -0.5) reversals++;
            const turn = Math.abs(Math.atan2(Math.sin(input.angle - f.prev.angle), Math.cos(input.angle - f.prev.angle)));
            if (turn > 0.15) aimSnaps++;
          }
          f.prev = { ...h, angle: input.angle };
        }
      }
    }
    const perSecond = (n: number) => (n / fightTicks) * TICK_RATE;
    expect(fightTicks).toBeGreaterThan(TICK_RATE * 60);
    expect(perSecond(reversals)).toBeLessThan(1.5);
    expect(perSecond(aimSnaps)).toBeLessThan(2);
  });
});

describe("bot hunting", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A bot at (600, 1000) fighting a target at (850, 1000), next to a bush at (900, 1000). */
  function setup(personality: Personality) {
    const state = new GameState();
    const geo = { ...emptyGeometry(), bushes: [{ x: 900, y: 1000, r: 40 }] };
    const self = new Player({ x: 600, y: 1000 });
    const target = new Player({ x: 850, y: 1000 });
    for (const p of [self, target]) {
      p.w0 = WEAPON_PISTOL;
      p.mag0 = WEAPONS[WEAPON_PISTOL].mag;
    }
    state.players.set("bot", self);
    state.players.set("target", target);
    const world: BotWorld = {
      tick: 0, phase: PHASE_DROP, players: state.players, loot: state.loot, geo, zone: state.zone, plane: state.plane,
    };
    const bot = new Bot("bot", SKILL.hard, personality);
    const run = (ticks: number) => {
      const out = [];
      for (let n = 0; n < ticks; n++) {
        world.tick++;
        const input = bot.think(self, world);
        stepPlayer(self, input.keys, geo);
        out.push(input);
      }
      return out;
    };
    return { self, target, world, bot, geo, run };
  }

  it("keeps shooting at a target that ducked into a bush, and goes in after it", () => {
    const { self, target, run } = setup("aggressive");
    run(TICK_RATE); // spots it
    target.x = 905; // into the bush, out of sight
    const inputs = run(2 * TICK_RATE);
    // Past the point where it would have looked for a new target.
    expect(inputs.slice(TICK_RATE / 2).some((i) => i.fire)).toBe(true);
    const last = inputs[inputs.length - 1];
    // Still aiming at the bush.
    expect(Math.abs(Math.atan2(1000 - self.y, 900 - self.x) - last.angle)).toBeLessThan(0.3);
    // Closed in to where the target is revealed.
    expect(Math.hypot(target.x - self.x, target.y - self.y)).toBeLessThan(BUSH_REVEAL_RANGE);
  });

  it("gives up once it has searched the bush and nobody is there", () => {
    const { target, run } = setup("aggressive");
    run(TICK_RATE);
    target.x = 905;
    run(5);
    target.x = 2600; // slipped away unseen (out of view range)
    target.y = 2600;
    const inputs = run(4 * TICK_RATE);
    expect(inputs.slice(-TICK_RATE).some((i) => i.fire)).toBe(false);
  });

  it("forgets a hidden target after a while", () => {
    // Looters don't chase, so this one covers the bush from where it is. Random
    // wandering afterwards could lead it back to the bush, so take chance out of it.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { target, run } = setup("looter");
    run(TICK_RATE);
    target.x = 905;
    const memory = SKILL.hard.memory;
    const inputs = run(memory + TICK_RATE);
    expect(inputs.slice(TICK_RATE, 2 * TICK_RATE).some((i) => i.fire)).toBe(true);
    expect(inputs.slice(memory + 5, memory + 20).some((i) => i.fire)).toBe(false);
  });

  it("fires back at someone shooting it from a bush", () => {
    // Random wandering could lead it to the bush and reveal the target; take chance out of it.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { self, target, world, bot, geo, run } = setup("looter");
    target.x = 905; // hidden from the start
    expect(run(TICK_RATE).some((i) => i.fire)).toBe(false);
    bot.onHurt(self, "target", target.x, target.y, geo, world.tick);
    const inputs = run(TICK_RATE);
    expect(inputs.some((i) => i.fire)).toBe(true);
  });
});
