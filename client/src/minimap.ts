import { MAP_SIZE, type GameState } from "@br/shared";

const SIZE = 168;
const SCALE = SIZE / MAP_SIZE;
const REDRAW_MS = 100;

export interface MinimapOptions {
  zone: boolean;
  /** Plane position 0..1 along its path, or null when there's no plane. */
  planeT: number | null;
}

/** Corner overview: terrain, the zone, the plane, and you. Other players are not shown. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private lastDraw = 0;

  constructor(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = canvas.style.height = `${SIZE}px`;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
  }

  /** Bake the static map once it has arrived. */
  setTerrain(state: GameState) {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement("canvas");
    c.width = c.height = SIZE * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const disc = (x: number, y: number, r: number) => {
      g.beginPath();
      g.arc(x * SCALE, y * SCALE, Math.max(1, r * SCALE), 0, Math.PI * 2);
      g.fill();
    };
    g.fillStyle = "#3b5e3f";
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = "#3a6ea5";
    state.ponds.forEach((p) => disc(p.x, p.y, p.r));
    g.fillStyle = "#2e6b31";
    state.bushes.forEach((b) => disc(b.x, b.y, b.r));
    g.fillStyle = "#6b4f3a";
    state.floors.forEach((f) => g.fillRect(f.x * SCALE, f.y * SCALE, f.w * SCALE, f.h * SCALE));
    g.fillStyle = "#7a7f73";
    state.rocks.forEach((r) => disc(r.x, r.y, r.r));
    this.terrain = c;
  }

  draw(state: GameState, me: { x: number; y: number } | null, myColor: number, opts: MinimapOptions) {
    const now = performance.now();
    if (now - this.lastDraw < REDRAW_MS || !this.terrain) return;
    this.lastDraw = now;
    const g = this.ctx;
    g.drawImage(this.terrain, 0, 0, SIZE, SIZE);

    if (opts.zone) {
      const z = state.zone;
      // Darken outside the zone (even-odd fill punches the circle out).
      g.fillStyle = "rgba(90, 20, 120, 0.45)";
      g.beginPath();
      g.rect(0, 0, SIZE, SIZE);
      g.arc(z.x * SCALE, z.y * SCALE, Math.max(0, z.r * SCALE), 0, Math.PI * 2);
      g.fill("evenodd");
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(z.x * SCALE, z.y * SCALE, Math.max(0, z.r * SCALE), 0, Math.PI * 2);
      g.stroke();
      if (z.tr < z.r) {
        g.setLineDash([3, 3]);
        g.beginPath();
        g.arc(z.tx * SCALE, z.ty * SCALE, Math.max(0, z.tr * SCALE), 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
    }

    if (opts.planeT !== null) {
      const p = state.plane;
      g.strokeStyle = "rgba(255,255,255,0.6)";
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(p.x0 * SCALE, p.y0 * SCALE);
      g.lineTo(p.x1 * SCALE, p.y1 * SCALE);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc((p.x0 + (p.x1 - p.x0) * opts.planeT) * SCALE, (p.y0 + (p.y1 - p.y0) * opts.planeT) * SCALE, 4, 0, Math.PI * 2);
      g.fill();
    }

    if (me) {
      g.fillStyle = `#${myColor.toString(16).padStart(6, "0")}`;
      g.strokeStyle = "#fff";
      g.lineWidth = 1;
      g.beginPath();
      g.arc(me.x * SCALE, me.y * SCALE, 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }
}
