import type { MapSchema } from "@colyseus/schema";
import {
  type Difficulty, type InputMessage, KEY_DOWN, KEY_HEAL, KEY_INTERACT, KEY_JUMP, KEY_LEFT, KEY_RELOAD,
  KEY_RIGHT, KEY_UP, LOOT_AMMO, LOOT_ARMOR, LOOT_MEDKIT, type Loot, MAP_SIZE, MAX_MEDKITS,
  type MapGeometry, PHASE_DROP, PHASE_PLAYING, PICKUP_RADIUS, PLAYER_RADIUS, type Plane,
  type Player, TICK_DT, TICK_RATE, WEAPONS, WEAPON_NONE, WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN,
  WEAPON_SMG, type Zone, activeWeapon, ammoTarget, canSee, circleBlocked, firstSolidHit, inCircles,
  isWeaponLoot, magIn, reserveIn, weaponIn,
} from "@br/shared";

interface Skill {
  aimError: number; // max radians of aim wobble
  reaction: [number, number]; // ticks before the first shot at a new target
  lead: number; // 1 = perfect leading of moving targets
  sight: number; // furthest target it will pick
}

export const SKILL: Record<Difficulty, Skill> = {
  easy: { aimError: 0.24, reaction: [16, 30], lead: 0.2, sight: 650 },
  normal: { aimError: 0.12, reaction: [8, 18], lead: 0.6, sight: 900 },
  hard: { aimError: 0.05, reaction: [4, 9], lead: 0.9, sight: 1100 },
};

export type Personality = "balanced" | "aggressive" | "camper" | "looter";

interface Style {
  /** Multiplies the weapon's preferred fighting distance. */
  rangeScale: number;
  /** Goes after targets beyond its weapon's range. */
  chases: boolean;
  /** Settles in a building or bush and waits. */
  camps: boolean;
  /** Grabs every useful item, not just what it badly needs. */
  greedy: boolean;
  /** Backs off below this much health while fighting. */
  retreatHp: number;
}

const STYLES: Record<Personality, Style> = {
  balanced: { rangeScale: 1, chases: true, camps: false, greedy: false, retreatHp: 25 },
  aggressive: { rangeScale: 0.7, chases: true, camps: false, greedy: false, retreatHp: 0 },
  camper: { rangeScale: 1.2, chases: false, camps: true, greedy: false, retreatHp: 30 },
  looter: { rangeScale: 1, chases: false, camps: false, greedy: true, retreatHp: 45 },
};

export function randomPersonality(): Personality {
  const roll = Math.random();
  return roll < 0.3 ? "aggressive" : roll < 0.55 ? "camper" : roll < 0.8 ? "looter" : "balanced";
}

// Ticks are 1/30 s.
const LOOT_SIGHT = 650;
const RETARGET_TICKS = 10;
const AIM_WOBBLE_TICKS = 6;
const STRAFE_TICKS: [number, number] = [30, 75];
const STUCK_CHECK_TICKS = TICK_RATE;
const PROBE_DISTANCE = PLAYER_RADIUS * 2.5;
/** How far inside the zone edge bots try to stay. */
const ZONE_MARGIN = 80;

/** Distance each weapon likes to fight at. */
const PREFERRED_RANGE: Record<number, number> = {
  [WEAPON_PISTOL]: 320,
  [WEAPON_SMG]: 230,
  [WEAPON_SHOTGUN]: 150,
  [WEAPON_RIFLE]: 550,
};

const DIRS = [
  { keys: KEY_RIGHT, x: 1, y: 0 },
  { keys: KEY_RIGHT | KEY_DOWN, x: Math.SQRT1_2, y: Math.SQRT1_2 },
  { keys: KEY_DOWN, x: 0, y: 1 },
  { keys: KEY_LEFT | KEY_DOWN, x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  { keys: KEY_LEFT, x: -1, y: 0 },
  { keys: KEY_LEFT | KEY_UP, x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  { keys: KEY_UP, x: 0, y: -1 },
  { keys: KEY_RIGHT | KEY_UP, x: Math.SQRT1_2, y: -Math.SQRT1_2 },
];

const NAMES = [
  "Ada", "Blitz", "Cobalt", "Dex", "Echo", "Fang", "Gizmo", "Havoc", "Ion", "Jinx",
  "Kilo", "Lynx", "Moxie", "Nova", "Onyx", "Pixel", "Quill", "Rex", "Sable", "Turbo",
  "Umbra", "Vex", "Widget", "Xeno", "Yeti", "Zap",
];

export function botName(index: number): string {
  const base = NAMES[index % NAMES.length];
  const round = Math.floor(index / NAMES.length);
  return `${base}${round > 0 ? round + 1 : ""} [bot]`;
}

export interface BotWorld {
  tick: number;
  phase: string;
  players: MapSchema<Player>;
  loot: MapSchema<Loot>;
  geo: MapGeometry;
  zone: Zone;
  plane: Plane;
}

/** Produces one input per tick for a server-controlled player. */
export class Bot {
  private seq = 0;
  private targetId: string | null = null;
  private targetLast: { x: number; y: number } | null = null;
  private nextRetargetTick = 0;
  private fireAfterTick = 0;
  private wobble = 0;
  private nextWobbleTick = 0;
  private strafe = 1;
  private nextStrafeTick = 0;
  private waypoint = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  private campSpot: { x: number; y: number } | null = null;
  private lootId: string | null = null;
  private stuckFrom = { x: 0, y: 0 };
  private nextStuckCheckTick = 0;
  private jumpAt = 0.12 + Math.random() * 0.73;
  private readonly style: Style;

  constructor(readonly id: string, private skill: Skill, readonly personality: Personality) {
    this.style = STYLES[personality];
  }

  think(self: Player, world: BotWorld): InputMessage {
    const { tick } = world;
    // Action keys are edge-triggered, so "pressing" one means holding it on alternate ticks.
    const press = tick % 2 === 0;

    if (self.inPlane) {
      return this.input(world.plane.t >= this.jumpAt && press ? KEY_JUMP : 0, 0, false, self.slot);
    }

    const combat = world.phase === PHASE_PLAYING || world.phase === PHASE_DROP;
    if (tick >= this.nextRetargetTick) {
      this.nextRetargetTick = tick + RETARGET_TICKS + randInt(0, 5);
      const next = combat ? this.findTarget(self, world) : null;
      if (next !== this.targetId) {
        this.targetId = next;
        this.targetLast = null;
        this.fireAfterTick = tick + randInt(...this.skill.reaction);
      }
      this.lootId = combat && !next ? this.findLoot(self, world) : null;
    }
    if (tick >= this.nextWobbleTick) {
      this.nextWobbleTick = tick + AIM_WOBBLE_TICKS;
      this.wobble = (Math.random() * 2 - 1) * this.skill.aimError;
    }
    if (tick >= this.nextStrafeTick) {
      this.nextStrafeTick = tick + randInt(...STRAFE_TICKS);
      if (Math.random() < 0.6) this.strafe = -this.strafe;
    }

    let target = this.targetId ? world.players.get(this.targetId) : undefined;
    if (target && (!target.alive || target.inPlane)) target = undefined;
    const loot = this.lootId ? world.loot.get(this.lootId) : undefined;
    const dist = target ? Math.max(1, Math.hypot(target.x - self.x, target.y - self.y)) : 0;
    const slot = this.chooseSlot(self, target ? dist : null);
    const weapon = WEAPONS[weaponIn(self, slot)] ?? WEAPONS[WEAPON_PISTOL];

    let moveX = 0;
    let moveY = 0;
    let angle = self.angle;
    let fire = false;
    let keys = 0;

    if (target) {
      const nx = (target.x - self.x) / dist;
      const ny = (target.y - self.y) / dist;

      // Lead the target by its velocity over the bullet's flight time.
      let aimX = target.x;
      let aimY = target.y;
      if (this.targetLast) {
        const flightTicks = dist / (weapon.speed * TICK_DT);
        aimX += (target.x - this.targetLast.x) * flightTicks * this.skill.lead;
        aimY += (target.y - this.targetLast.y) * flightTicks * this.skill.lead;
      }
      this.targetLast = { x: target.x, y: target.y };
      angle = Math.atan2(aimY - self.y, aimX - self.x) + this.wobble;

      const clear = firstSolidHit(world.geo, self.x, self.y, target.x, target.y) < 0;
      fire = clear && tick >= this.fireAfterTick && dist < weapon.range * 0.9 && slot === self.slot;

      if (!clear) {
        moveX = nx;
        moveY = ny;
      } else {
        const preferred = (PREFERRED_RANGE[weaponIn(self, slot)] ?? 300) * this.style.rangeScale;
        let radial = clampUnit((dist - preferred) / 150);
        if (self.hp < this.style.retreatHp) radial = -1;
        moveX = nx * radial - ny * this.strafe;
        moveY = ny * radial + nx * this.strafe;
      }
    } else {
      this.targetId = null;
      if (combat && self.medkits > 0 && self.hp < 60 && !self.healing && press) keys |= KEY_HEAL;
      const mag = magIn(self, self.slot);
      const w = activeWeapon(self);
      if (combat && w !== WEAPON_NONE && mag < WEAPONS[w].mag / 2 && !self.reloading && press
          && (WEAPONS[w].reserve === 0 || reserveIn(self, self.slot) > 0)) {
        keys |= KEY_RELOAD;
      }

      if (loot) {
        moveX = loot.x - self.x;
        moveY = loot.y - self.y;
        angle = Math.atan2(moveY, moveX);
        if (Math.hypot(moveX, moveY) < PICKUP_RADIUS - 4 && isWeaponLoot(loot.type)) {
          if (press) keys |= KEY_INTERACT;
          moveX = moveY = 0;
        }
      } else if (this.style.camps && combat) {
        this.campSpot ??= this.pickCampSpot(world);
        moveX = this.campSpot.x - self.x;
        moveY = this.campSpot.y - self.y;
        if (Math.hypot(moveX, moveY) < 40) {
          moveX = moveY = 0;
          angle += 0.02; // look around
        } else {
          angle = Math.atan2(moveY, moveX);
        }
      } else {
        if (Math.hypot(this.waypoint.x - self.x, this.waypoint.y - self.y) < 60) this.waypoint = this.pickWaypoint(world);
        moveX = this.waypoint.x - self.x;
        moveY = this.waypoint.y - self.y;
        angle = Math.atan2(moveY, moveX);
      }
    }

    // Getting back inside the zone beats everything except shooting.
    if (world.phase === PHASE_PLAYING) {
      const z = world.zone;
      const safeR = Math.max(0, z.tr - ZONE_MARGIN);
      const toTarget = Math.hypot(z.tx - self.x, z.ty - self.y);
      const outsideNow = Math.hypot(z.x - self.x, z.y - self.y) > z.r - ZONE_MARGIN / 2;
      if (outsideNow || (z.shrinking && toTarget > safeR)) {
        moveX = z.tx - self.x;
        moveY = z.ty - self.y;
        if (!target) angle = Math.atan2(moveY, moveX);
        this.lootId = null;
        if (this.campSpot && Math.hypot(this.campSpot.x - z.tx, this.campSpot.y - z.ty) > safeR) this.campSpot = null;
      }
    }

    // Wedged against something? Pick somewhere else to go.
    const wantsToMove = moveX !== 0 || moveY !== 0;
    if (tick >= this.nextStuckCheckTick) {
      if (wantsToMove && Math.hypot(self.x - this.stuckFrom.x, self.y - this.stuckFrom.y) < 20) {
        this.waypoint = this.pickWaypoint(world);
        this.campSpot = null;
        this.strafe = -this.strafe;
        this.targetId = null;
        this.lootId = null;
      }
      this.stuckFrom = { x: self.x, y: self.y };
      this.nextStuckCheckTick = tick + STUCK_CHECK_TICKS;
    }

    if (self.healing) fire = false; // shooting would cancel the heal
    keys |= chooseKeys(self, moveX, moveY, world.geo);
    return this.input(keys, angle, fire, slot);
  }

  private input(keys: number, angle: number, fire: boolean, slot: number): InputMessage {
    return { seq: ++this.seq, keys, angle, fire, slot };
  }

  /** Best slot for the fight at hand (or the best weapon to hold ready). */
  private chooseSlot(self: Player, dist: number | null): number {
    let best = self.slot;
    let bestScore = -Infinity;
    for (const slot of [0, 1]) {
      const w = weaponIn(self, slot);
      if (w === WEAPON_NONE) continue;
      const empty = magIn(self, slot) === 0 && reserveIn(self, slot) === 0 && WEAPONS[w].reserve > 0;
      if (empty) continue;
      let score = dist === null
        ? (w === WEAPON_PISTOL ? 0 : 1)
        : -Math.abs((PREFERRED_RANGE[w] ?? 300) - dist) - (dist > WEAPONS[w].range ? 1000 : 0);
      if (magIn(self, slot) === 0) score -= 400; // something loaded beats reloading mid-fight
      if (slot === self.slot) score += 20; // don't flip-flop
      if (score > bestScore) {
        bestScore = score;
        best = slot;
      }
    }
    return best;
  }

  private findTarget(self: Player, world: BotWorld): string | null {
    const reach = this.style.chases
      ? this.skill.sight
      : Math.min(this.skill.sight, Math.max(WEAPONS[weaponIn(self, 0)]?.range ?? 0, WEAPONS[weaponIn(self, 1)]?.range ?? 0));
    let best: string | null = null;
    let bestDist = reach;
    world.players.forEach((p, sid) => {
      if (sid === this.id || !p.alive || p.inPlane) return;
      const d = Math.hypot(p.x - self.x, p.y - self.y);
      if (d < bestDist && canSee(world.geo, self.x, self.y, p.x, p.y)) {
        best = sid;
        bestDist = d;
      }
    });
    return best;
  }

  /** Nearest visible loot this bot wants. */
  private findLoot(self: Player, world: BotWorld): string | null {
    const greedy = this.style.greedy;
    const hasSpareSlot = weaponIn(self, 0) === WEAPON_NONE || weaponIn(self, 1) === WEAPON_NONE
      || weaponIn(self, 0) === WEAPON_PISTOL || weaponIn(self, 1) === WEAPON_PISTOL;
    const ammoSlot = ammoTarget(self);
    const lowAmmo = ammoSlot >= 0 && reserveIn(self, ammoSlot) < WEAPONS[weaponIn(self, ammoSlot)].reserve / (greedy ? 1 : 3);
    const wants = (type: number) =>
      (isWeaponLoot(type) && hasSpareSlot)
      || (type === LOOT_MEDKIT && self.medkits < (greedy ? MAX_MEDKITS : 1))
      || (type === LOOT_ARMOR && self.armor < (greedy ? 100 : 50))
      || (type === LOOT_AMMO && lowAmmo);

    let best: string | null = null;
    let bestDist = LOOT_SIGHT;
    world.loot.forEach((l, id) => {
      if (!wants(l.type)) return;
      const d = Math.hypot(l.x - self.x, l.y - self.y);
      if (d < bestDist && canSee(world.geo, self.x, self.y, l.x, l.y)) {
        best = id;
        bestDist = d;
      }
    });
    return best;
  }

  /** Somewhere to wander to, inside where the zone is heading. */
  private pickWaypoint(world: BotWorld) {
    const z = world.zone;
    const zoned = world.phase === PHASE_PLAYING;
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = zoned
        ? { x: z.tx + (Math.random() * 2 - 1) * z.tr * 0.7, y: z.ty + (Math.random() * 2 - 1) * z.tr * 0.7 }
        : { x: 100 + Math.random() * (MAP_SIZE - 200), y: 100 + Math.random() * (MAP_SIZE - 200) };
      if (!circleBlocked(world.geo, p.x, p.y, PLAYER_RADIUS + 10)) return p;
    }
    return { x: z.tx, y: z.ty };
  }

  /** A building or bush inside the next zone, else just somewhere in it. */
  private pickCampSpot(world: BotWorld) {
    const z = world.zone;
    const inside = (x: number, y: number) => Math.hypot(x - z.tx, y - z.ty) < Math.max(0, z.tr - ZONE_MARGIN);
    const spots = [
      ...world.geo.buildings.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })),
      ...world.geo.bushes.map((b) => ({ x: b.x, y: b.y })),
    ].filter((s) => inside(s.x, s.y) && !circleBlocked(world.geo, s.x, s.y, PLAYER_RADIUS + 4));
    return spots.length > 0 ? spots[randInt(0, spots.length - 1)] : this.pickWaypoint(world);
  }
}

/** The 8-way direction closest to the desired one that isn't walking into something solid. */
function chooseKeys(self: Player, x: number, y: number, geo: MapGeometry): number {
  const len = Math.hypot(x, y);
  if (len < 1e-3) return 0;
  x /= len;
  y /= len;

  let bestKeys = 0;
  let bestScore = -Infinity;
  for (const d of DIRS) {
    let score = d.x * x + d.y * y;
    if (score < -0.2) continue;
    const px = self.x + d.x * PROBE_DISTANCE;
    const py = self.y + d.y * PROBE_DISTANCE;
    if (circleBlocked(geo, px, py, PLAYER_RADIUS)) score -= 2;
    else if (inCircles(geo.water, px, py) >= 0) score -= 0.3; // wade only if it's much shorter
    if (score > bestScore) {
      bestScore = score;
      bestKeys = d.keys;
    }
  }
  return bestKeys;
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function clampUnit(v: number) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
