import { KEY_DOWN, KEY_HEAL, KEY_INTERACT, KEY_JUMP, KEY_LEFT, KEY_RELOAD, KEY_RIGHT, KEY_UP } from "@br/shared";

const STICK_RADIUS = 50;
const MOVE_DEADZONE = 0.3;
const AIM_DEADZONE = 0.25;
/** Push the aim stick past this to shoot. */
const FIRE_THRESHOLD = 0.6;

export function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

class Stick {
  /** Unit-ish vector, length 0..1. */
  x = 0;
  y = 0;
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private base: HTMLElement;
  private knob: HTMLElement;

  constructor(zone: HTMLElement) {
    this.base = zone.querySelector(".stick")!;
    this.knob = zone.querySelector(".knob")!;
    zone.addEventListener("pointerdown", (e) => {
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      const rect = zone.getBoundingClientRect();
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.base.style.left = `${e.clientX - rect.left}px`;
      this.base.style.top = `${e.clientY - rect.top}px`;
      this.base.classList.add("on");
      this.move(e);
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.pointerId) this.move(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.x = this.y = 0;
      this.base.classList.remove("on");
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  get length() {
    return Math.hypot(this.x, this.y);
  }

  private move(e: PointerEvent) {
    let dx = e.clientX - this.originX;
    let dy = e.clientY - this.originY;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx = (dx / d) * STICK_RADIUS;
      dy = (dy / d) * STICK_RADIUS;
    }
    this.x = dx / STICK_RADIUS;
    this.y = dy / STICK_RADIUS;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

/** Twin-stick controls plus action buttons, for phones and tablets. */
export class TouchControls {
  private root = document.getElementById("touch")!;
  private moveStick = new Stick(document.getElementById("stick-move")!);
  private aimStick = new Stick(document.getElementById("stick-aim")!);
  private held = new Set<string>();
  /** Presses not yet seen by keys(): a quick tap can start and end between two ticks. */
  private latched = new Set<string>();
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(onSwap: () => void) {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("#touch-buttons button")) {
      const action = button.dataset.action!;
      this.buttons.set(action, button);
      button.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (action === "swap") {
          onSwap();
        } else {
          this.held.add(action);
          this.latched.add(action);
        }
      });
      const release = () => this.held.delete(action);
      button.addEventListener("pointerup", release);
      button.addEventListener("pointercancel", release);
      button.addEventListener("pointerleave", release);
    }
    document.body.classList.add("touch");
  }

  show(visible: boolean) {
    this.root.hidden = !visible;
  }

  /** Which buttons make sense right now. */
  setMode(inPlane: boolean) {
    for (const [action, button] of this.buttons) button.hidden = inPlane !== (action === "jump");
  }

  /** Movement and held action buttons as KEY_* bits. */
  keys(): number {
    let keys = 0;
    const m = this.moveStick;
    if (m.length > MOVE_DEADZONE) {
      // Quantize to 8 directions, like the keyboard.
      const a = Math.round(Math.atan2(m.y, m.x) / (Math.PI / 4)) * (Math.PI / 4);
      const x = Math.round(Math.cos(a));
      const y = Math.round(Math.sin(a));
      if (x > 0) keys |= KEY_RIGHT;
      if (x < 0) keys |= KEY_LEFT;
      if (y > 0) keys |= KEY_DOWN;
      if (y < 0) keys |= KEY_UP;
    }
    const down = (action: string) => this.held.has(action) || this.latched.has(action);
    if (down("interact")) keys |= KEY_INTERACT;
    if (down("reload")) keys |= KEY_RELOAD;
    if (down("heal")) keys |= KEY_HEAL;
    if (down("jump")) keys |= KEY_JUMP;
    this.latched.clear();
    return keys;
  }

  /** Aim angle while the aim stick is pushed, else null. */
  aim(): number | null {
    const a = this.aimStick;
    return a.length > AIM_DEADZONE ? Math.atan2(a.y, a.x) : null;
  }

  firing(): boolean {
    return this.aimStick.length > FIRE_THRESHOLD;
  }
}
