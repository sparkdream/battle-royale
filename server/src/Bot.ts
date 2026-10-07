import type { MapSchema } from "@colyseus/schema";
import {
  type Difficulty, type InputMessage, KEY_DOWN, KEY_HEAL, KEY_INTERACT, KEY_JUMP, KEY_LEFT, KEY_RELOAD,
  KEY_RIGHT, KEY_UP, LOOT_AMMO, LOOT_ARMOR, LOOT_MEDKIT, type Loot, MAP_SIZE, MAX_MEDKITS,
  type MapGeometry, BUSH_REVEAL_RANGE, PHASE_DROP, PHASE_PLAYING, PICKUP_RADIUS, PLAYER_RADIUS, type Plane,
  type Player, TICK_DT, TICK_RATE, WEAPONS, WEAPON_NONE, WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN,
  WEAPON_SMG, type Zone, activeWeapon, ammoTarget, canSee, circleBlocked, firstSolidHit, inCircles, inRects,
  isWeaponLoot, magIn, reserveIn, weaponIn,
} from "@br/shared";

interface Skill {
  aimError: number; // max radians of aim wobble
  reaction: [number, number]; // ticks before the first shot at a new target
  lead: number; // 1 = perfect leading of moving targets
  sight: number; // furthest target it will pick
  memory: number; // ticks it keeps hunting a target that slipped out of sight
}

export const SKILL: Record<Difficulty, Skill> = {
  easy: { aimError: 0.32, reaction: [22, 40], lead: 0.1, sight: 600, memory: 3 * TICK_RATE },
  normal: { aimError: 0.16, reaction: [11, 24], lead: 0.5, sight: 850, memory: 6 * TICK_RATE },
  hard: { aimError: 0.07, reaction: [6, 12], lead: 0.8, sight: 1050, memory: 9 * TICK_RATE },
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
/** Fraction of the way the aim wobble moves to its next offset each tick, so the gun drifts instead of snapping. */
const WOBBLE_EASE = 0.25;
/**
 * Ticks a clear (or blocked) shot must last before the bot changes from fighting at range to
 * closing in (or back), so it doesn't flip between the two at the edge of cover.
 */
const SHOT_HOLD_TICKS = 10;
const STRAFE_TICKS: [number, number] = [30, 75];
const STUCK_CHECK_TICKS = TICK_RATE;
const PROBE_DISTANCE = PLAYER_RADIUS * 2.5;
/** How far to the side a strafing bot checks that it would still have a shot. */
const STRAFE_PROBE = 120;
/**
 * Bonus for heading the way the bot already goes (scaled by how close a direction is to it),
 * so near-ties, like an obstacle dead ahead, don't make it flip back and forth every tick.
 */
const KEEP_HEADING = 0.3;
/** A hunted target is given up on once the bot is this close to where it hid and still can't see it. */
const SEARCH_RADIUS = 40;
/** How close a hunter gets to a bush it saw someone go into (they'd be revealed well before). */
const BUSH_SEARCH_RANGE = BUSH_REVEAL_RANGE - 50;
/** Firing into cover at a target it can't see, in bursts: on for this many ticks, then off as long. */
const SUPPRESS_BURST_TICKS = 8;
/** How far from a bush's edge a guessed position still counts as "in that bush". */
const BUSH_SNAP = 30;
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
  /** Tick the target was last in sight (or last shot at us from hiding). */
  private seenTick = 0;
  /** Where the target is hiding while out of sight, null while it's in sight. */
  private hideout: { x: number; y: number } | null = null;
  private nextRetargetTick = 0;
  private fireAfterTick = 0;
  private wobble = 0;
  private wobbleTo = 0;
  /** Closing in on a target it has no shot at, rather than fighting at range. */
  private approach = false;
  private clearShot = true;
  private clearShotSince = 0;
  /** Strafing doesn't switch sides for cover again before this tick. */
  private asideFlipAfterTick = 0;
  private nextWobbleTick = 0;
  private strafe = 1;
  private nextStrafeTick = 0;
  private waypoint = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  private campSpot: { x: number; y: number } | null = null;
  private lootId: string | null = null;
  private stuckFrom = { x: 0, y: 0 };
  private nextStuckCheckTick = 0;
  /** Index in DIRS of the last movement direction, -1 when standing still. */
  private heading = -1;
  private jumpAt = 0.12 + Math.random() * 0.73;
  private readonly style: Style;

  /** `skill` changes when the room's difficulty does. */
  constructor(readonly id: string, public skill: Skill, readonly personality: Personality) {
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
      // Someone in sight takes over; with nobody in sight, keep hunting whoever went into hiding.
      if (next !== this.targetId && (next || !this.hideout)) this.setTarget(next, tick);
      this.lootId = combat && !this.targetId ? this.findLoot(self, world) : null;
    }
    if (tick >= this.nextWobbleTick) {
      this.nextWobbleTick = tick + AIM_WOBBLE_TICKS;
      this.wobbleTo = (Math.random() * 2 - 1) * this.skill.aimError;
    }
    this.wobble += (this.wobbleTo - this.wobble) * WOBBLE_EASE;
    if (tick >= this.nextStrafeTick) {
      this.nextStrafeTick = tick + randInt(...STRAFE_TICKS);
      if (Math.random() < 0.6) this.strafe = -this.strafe;
    }

    let target = this.targetId ? world.players.get(this.targetId) : undefined;
    if (target && (!target.alive || target.inPlane)) target = undefined;
    // Out of sight (in a bush, under a roof, behind a wall): hunt it where it vanished.
    if (target && canSee(world.geo, self.x, self.y, target.x, target.y)) {
      this.seenTick = tick;
      this.hideout = null;
    } else if (target) {
      // The tick it vanishes, it's right where it stepped into cover.
      this.hideout ??= coverAt(world.geo, target.x, target.y, 0);
      const h = this.hideout;
      const away = Math.hypot(h.x - self.x, h.y - self.y);
      const searched = away < SEARCH_RADIUS
        || (inCircles(world.geo.bushes, h.x, h.y) >= 0 && away < BUSH_SEARCH_RANGE)
        || (inRects(world.geo.buildings, h.x, h.y) >= 0
          && inRects(world.geo.buildings, h.x, h.y) === inRects(world.geo.buildings, self.x, self.y));
      if (searched || tick - this.seenTick > this.skill.memory) {
        this.setTarget(null, tick);
        target = undefined;
      }
    }
    const hideout = target ? this.hideout : null;
    // Where it's fighting: the target, or where it's hiding.
    const goal = hideout ?? target;
    const loot = this.lootId ? world.loot.get(this.lootId) : undefined;
    const dist = goal ? Math.max(1, Math.hypot(goal.x - self.x, goal.y - self.y)) : 0;
    const slot = this.chooseSlot(self, target ? dist : null);
    const weapon = WEAPONS[weaponIn(self, slot)] ?? WEAPONS[WEAPON_PISTOL];

    let moveX = 0;
    let moveY = 0;
    let angle = self.angle;
    let fire = false;
    let keys = 0;
    /** Heading straight for the target rather than keeping its distance. */
    let pushing = false;

    if (target && goal) {
      const nx = (goal.x - self.x) / dist;
      const ny = (goal.y - self.y) / dist;

      // Lead the target by its velocity over the bullet's flight time.
      let aimX = goal.x;
      let aimY = goal.y;
      if (this.targetLast && !hideout) {
        const flightTicks = dist / (weapon.speed * TICK_DT);
        aimX += (target.x - this.targetLast.x) * flightTicks * this.skill.lead;
        aimY += (target.y - this.targetLast.y) * flightTicks * this.skill.lead;
      }
      this.targetLast = hideout ? null : { x: target.x, y: target.y };
      angle = Math.atan2(aimY - self.y, aimX - self.x) + this.wobble;

      const clear = firstSolidHit(world.geo, self.x, self.y, goal.x, goal.y) < 0;
      fire = clear && tick >= this.fireAfterTick && dist < weapon.range * 0.9 && slot === self.slot;
      // Spray the cover it's hiding in, in bursts so there's ammo left when it shows itself.
      if (hideout && Math.floor(tick / SUPPRESS_BURST_TICKS) % 2 === 1) fire = false;

      let preferred = (PREFERRED_RANGE[weaponIn(self, slot)] ?? 300) * this.style.rangeScale;
      // Once it's flushed out of a bush, don't back off so far that it's hidden again.
      if (!hideout && inCircles(world.geo.bushes, goal.x, goal.y) >= 0) preferred = Math.min(preferred, BUSH_SEARCH_RANGE - 10);
      // Chasers go in after it to flush it out (unless hurting); the others hold their ground and cover the spot.
      const charge = hideout && this.style.chases && self.hp >= this.style.retreatHp;
      if (clear !== this.clearShot) {
        this.clearShot = clear;
        this.clearShotSince = tick;
      }
      if (tick - this.clearShotSince >= SHOT_HOLD_TICKS) this.approach = !clear;
      if (charge || (this.approach && !hideout)) {
        moveX = nx;
        moveY = ny;
        pushing = true;
      } else {
        let radial = clampUnit((dist - preferred) / 150);
        if (self.hp < this.style.retreatHp) radial = -1;
        // Don't strafe behind cover that blocks our own shot: we'd lose it, step
        // back out to get it again, and dither on the edge.
        const aside = (side: number) => firstSolidHit(world.geo,
          self.x - ny * side * STRAFE_PROBE, self.y + nx * side * STRAFE_PROBE, goal.x, goal.y) >= 0;
        // At most once a strafe: when both sides keep swapping, flipping each tick is the jitter.
        if (tick >= this.asideFlipAfterTick && aside(this.strafe) && !aside(-this.strafe)) {
          this.strafe = -this.strafe;
          this.nextStrafeTick = tick + randInt(...STRAFE_TICKS);
          this.asideFlipAfterTick = tick + STRAFE_TICKS[0];
        }
        moveX = nx * radial - ny * this.strafe;
        moveY = ny * radial + nx * this.strafe;
      }
    } else {
      if (this.targetId) this.setTarget(null, tick);
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
        // Strafing back and forth can look stuck too; only give up on a target it can't get to.
        if (pushing) this.setTarget(null, tick);
        this.lootId = null;
      }
      this.stuckFrom = { x: self.x, y: self.y };
      this.nextStuckCheckTick = tick + STUCK_CHECK_TICKS;
    }

    if (self.healing) fire = false; // shooting would cancel the heal
    this.heading = chooseHeading(self, moveX, moveY, world.geo, this.heading);
    if (this.heading >= 0) keys |= DIRS[this.heading].keys;
    return this.input(keys, angle, fire, slot);
  }

  /**
   * Shot by `attackerId`, now at (x, y). Unless it's busy with someone in sight, the bot
   * turns on the shooter, guessing where the shot came from: hiding doesn't make you safe
   * to shoot from.
   */
  onHurt(self: Player, attackerId: string, x: number, y: number, geo: MapGeometry, tick: number) {
    if (this.targetId && !this.hideout) return; // busy with someone in the open
    if (this.targetId !== attackerId) this.setTarget(attackerId, tick);
    const err = Math.random() * this.skill.aimError * Math.hypot(x - self.x, y - self.y) * 0.5;
    const dir = Math.random() * Math.PI * 2;
    this.hideout = coverAt(geo, x + Math.cos(dir) * err, y + Math.sin(dir) * err, BUSH_SNAP);
    this.seenTick = tick;
    this.lootId = null;
  }

  private setTarget(id: string | null, tick: number) {
    this.targetId = id;
    this.targetLast = null;
    this.hideout = null;
    this.seenTick = tick;
    this.fireAfterTick = tick + randInt(...this.skill.reaction);
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

/** Where someone at about (x, y) is hiding: the middle of the bush there (within `slack` of it), else that spot. */
function coverAt(geo: MapGeometry, x: number, y: number, slack: number) {
  for (const b of geo.bushes) {
    if ((b.x - x) ** 2 + (b.y - y) ** 2 <= (b.r + slack) ** 2) return { x: b.x, y: b.y };
  }
  return { x, y };
}

/**
 * Index in DIRS of the 8-way direction closest to the desired one that isn't
 * walking into something solid, leaning towards `prev` on a near-tie. -1: stand still.
 */
function chooseHeading(self: Player, x: number, y: number, geo: MapGeometry, prev: number): number {
  const len = Math.hypot(x, y);
  if (len < 1e-3) return -1;
  x /= len;
  y /= len;

  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    let score = d.x * x + d.y * y;
    if (score < -0.2) continue;
    const px = self.x + d.x * PROBE_DISTANCE;
    const py = self.y + d.y * PROBE_DISTANCE;
    if (circleBlocked(geo, px, py, PLAYER_RADIUS)) score -= 2;
    else if (inCircles(geo.water, px, py) >= 0) score -= 0.3; // wade only if it's much shorter
    if (prev >= 0) score += KEEP_HEADING * (d.x * DIRS[prev].x + d.y * DIRS[prev].y);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function clampUnit(v: number) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
