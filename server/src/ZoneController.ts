import { MAP_SIZE, TICK_RATE, type Zone, ZONE_START_RADIUS, ZONE_STAGES } from "@br/shared";

/** Drives the synced Zone through its wait → shrink stages. */
export class ZoneController {
  private stage = -1;
  private shrinking = false;
  private ticksLeft = 0;
  private totalTicks = 0;
  private from = { x: 0, y: 0, r: 0 };

  /** `speed` > 1 makes every stage proportionally shorter (handy for testing). */
  constructor(private zone: Zone, private speed = 1) {
    this.reset();
  }

  get active() {
    return this.stage >= 0;
  }

  reset() {
    this.stage = -1;
    this.shrinking = false;
    this.ticksLeft = 0;
    const z = this.zone;
    z.x = z.tx = MAP_SIZE / 2;
    z.y = z.ty = MAP_SIZE / 2;
    z.r = z.tr = ZONE_START_RADIUS;
    z.shrinking = false;
  }

  start() {
    this.reset();
    this.stage = 0;
    this.beginWait();
  }

  update() {
    if (!this.active || this.stage >= ZONE_STAGES.length) return;
    this.ticksLeft--;
    const z = this.zone;

    if (!this.shrinking) {
      if (this.ticksLeft > 0) return;
      this.shrinking = z.shrinking = true;
      this.from = { x: z.x, y: z.y, r: z.r };
      this.ticksLeft = this.totalTicks = this.ticks(ZONE_STAGES[this.stage].shrink);
      return;
    }

    const f = 1 - Math.max(0, this.ticksLeft) / this.totalTicks;
    z.x = this.from.x + (z.tx - this.from.x) * f;
    z.y = this.from.y + (z.ty - this.from.y) * f;
    z.r = this.from.r + (z.tr - this.from.r) * f;
    if (this.ticksLeft > 0) return;

    this.shrinking = z.shrinking = false;
    this.stage++;
    if (this.stage < ZONE_STAGES.length) this.beginWait();
  }

  /** Damage per second outside the zone. */
  get dps(): number {
    if (!this.active) return 0;
    return ZONE_STAGES[Math.min(this.stage, ZONE_STAGES.length - 1)].dps;
  }

  /** Seconds until the zone next starts or stops moving (0 once it's final). */
  get secondsLeft(): number {
    if (!this.active || this.stage >= ZONE_STAGES.length) return 0;
    return Math.ceil(this.ticksLeft / TICK_RATE);
  }

  isOutside(x: number, y: number): boolean {
    const z = this.zone;
    return (x - z.x) ** 2 + (y - z.y) ** 2 > z.r * z.r;
  }

  private beginWait() {
    const z = this.zone;
    const r = ZONE_STAGES[this.stage].radius;
    // The next circle must fit inside the current one; prefer spots on the map.
    const maxOffset = Math.max(0, z.r - r);
    let tx = z.x;
    let ty = z.y;
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * maxOffset;
      tx = z.x + Math.cos(a) * d;
      ty = z.y + Math.sin(a) * d;
      const margin = Math.min(r, MAP_SIZE * 0.2);
      if (tx > margin && ty > margin && tx < MAP_SIZE - margin && ty < MAP_SIZE - margin) break;
    }
    z.tx = tx;
    z.ty = ty;
    z.tr = r;
    this.shrinking = z.shrinking = false;
    this.ticksLeft = this.ticks(ZONE_STAGES[this.stage].wait);
  }

  private ticks(seconds: number) {
    return Math.max(1, Math.round((seconds * TICK_RATE) / this.speed));
  }
}
