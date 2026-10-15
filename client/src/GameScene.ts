import Phaser from "phaser";
import type { Room } from "@colyseus/sdk";
import {
  BULLET_RADIUS, CRATE_SIZE, type CrateRect, DROP_SECONDS, type GameState, type HitMessage, INTERP_DELAY_MS,
  type InputMessage, KEY_DOWN, KEY_HEAL, KEY_INTERACT, KEY_JUMP, KEY_LEFT, KEY_RELOAD, KEY_RIGHT,
  KEY_UP, type KillMessage, LOOT_AMMO, LOOT_ARMOR, LOOT_MEDKIT, type Loot, MAP_SIZE, MAX_HEALTH,
  MEDKIT_TICKS, MSG_HIT, MSG_INPUT, MSG_KILL, MSG_LATENCY, MSG_MATCH_END, MSG_SPECTATE,
  MSG_NOTICE, MSG_SPECTATE_NEXT, MSG_STATS, MSG_WEB3, type MapGeometry, type MatchEndMessage, PHASE_DROP, PHASE_ENDED,
  PHASE_LOBBY, PHASE_PLAYING, PICKUP_RADIUS, PLAYER_COLORS, PLAYER_RADIUS, type Player,
  type SpectateMessage, type StatsMessage, TICK_MS, WEAPONS, WEAPON_NONE, emptyGeometry,
  firstSolidHit, inCircles, inRects, isWeaponLoot, magIn, reserveIn, stepPlayer, weaponIn,
  type Web3Notice,
} from "@br/shared";
import type { Sfx } from "./audio";
import { recordMatch } from "./career";
import type { Hud } from "./hud";
import { Minimap } from "./minimap";
import type { TouchControls } from "./touch";
import { explorerTxUrl } from "./wallet";

const MAX_CATCHUP_STEPS = 5;
// Reconciliation errors bigger than this are teleports: snap, don't smooth.
const SNAP_DISTANCE = 120;
const CORRECTION_DECAY = 15; // per second
const HEARING_RANGE = 1300;
const ZONE_FOG = 0x5a1478;
const HIT_MARKER_MS = 140;
// Fraction of the way the camera closes on a spectate target each frame: eases
// out the jitter of someone else's movement (and glides between targets).
const SPECTATE_CAMERA_LERP = 0.2;

const DEPTH = {
  water: 0.5, floor: 1, loot: 6, solid: 7, player: 10, bullet: 12, flash: 13, bush: 14, roof: 15,
  zone: 20, plane: 22, effect: 25, crosshair: 30,
};

interface Snapshot { t: number; x: number; y: number; angle: number; alive: boolean }

interface PlayerView {
  root: Phaser.GameObjects.Container;
  gun: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Arc;
  color: number;
  buffer: Snapshot[];
  lastHp: number;
  lastAlive: boolean;
}

interface BulletView {
  obj: Phaser.GameObjects.Arc;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  traveled: number;
  /** Where it will stop: weapon range or the first solid thing in its path. */
  maxTravel: number;
}

interface OwnState {
  hp: number;
  armor: number;
  medkits: number;
  w0: number;
  w1: number;
  res0: number;
  res1: number;
  slot: number;
  reloading: boolean;
  healing: boolean;
  inPlane: boolean;
}

type KeyName = "W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT" | "E" | "R" | "H" | "SPACE";
type Keys = Record<KeyName, Phaser.Input.Keyboard.Key>;

export class GameScene extends Phaser.Scene {
  private room: Room<any, GameState>;
  private hud: Hud;
  private sfx: Sfx;
  private touch: TouchControls | null;
  private keys!: Keys;
  private minimap!: Minimap;
  private zoneGfx!: Phaser.GameObjects.Graphics;
  private crosshair!: Phaser.GameObjects.Graphics;
  private plane!: Phaser.GameObjects.Container;
  private disposed = false;
  /** The in-game menu is open: send no movement or actions. */
  private paused = false;

  private views = new Map<string, PlayerView>();
  private bullets = new Map<string, BulletView>();
  private bulletPool: Phaser.GameObjects.Arc[] = [];
  private lootViews = new Map<string, Phaser.GameObjects.Container>();
  private crateViews = new Map<string, { obj: Phaser.GameObjects.Container; hp: number }>();
  private roofs: Phaser.GameObjects.Rectangle[] = [];
  private bushViews: Phaser.GameObjects.Arc[] = [];
  private geo: MapGeometry = emptyGeometry();
  private mapLoaded = false;
  private seen = new Set<string>();
  private lastPhase = "";
  private spectateId = "";
  private followId: string | null = null;
  private stats: StatsMessage | null = null;
  private mine: OwnState | null = null;
  private actionStart = 0;
  private hitMarkerUntil = 0;
  /** Whether the crosshair is drawn, standing in for the hidden mouse cursor. */
  private aiming = false;
  private planeT = { value: 0, at: 0 };

  // Client-side prediction of the local player.
  private seq = 0;
  private pending: InputMessage[] = [];
  private spawned = false;
  private pred = { x: 0, y: 0 };
  private prevPred = { x: 0, y: 0 };
  private correction = { x: 0, y: 0 };
  private accumulator = 0;
  private aim = 0;
  private renderPos = { x: 0, y: 0 };
  /** Weapon slot we're asking the server for. */
  private wantSlot = 0;

  constructor(room: Room<any, GameState>, hud: Hud, sfx: Sfx, touch: TouchControls | null) {
    super("game");
    this.room = room;
    this.hud = hud;
    this.sfx = sfx;
    this.touch = touch;
  }

  create() {
    this.cameras.main.setBounds(0, 0, MAP_SIZE, MAP_SIZE).setRoundPixels(true);
    this.fitZoom();
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.fitZoom());
    this.drawGround();
    this.zoneGfx = this.add.graphics().setDepth(DEPTH.zone);
    this.crosshair = this.add.graphics().setDepth(DEPTH.crosshair);
    this.plane = this.createPlane();
    this.minimap = new Minimap(this.hud.minimapCanvas);

    this.input.mouse?.disableContextMenu();
    const kb = this.input.keyboard!;
    this.keys = kb.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,E,R,H,SPACE") as Keys;
    kb.on("keydown-ONE", () => this.selectSlot(0));
    kb.on("keydown-TWO", () => this.selectSlot(1));
    kb.on("keydown-Q", () => this.swapWeapon());
    kb.on("keydown-SPACE", () => this.spectateNextIfDead());
    this.input.on("wheel", () => this.swapWeapon());
    this.input.on("pointerdown", () => this.spectateNextIfDead());

    // Room events can still arrive after the scene is torn down; ignore them then.
    const live = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
      if (!this.disposed) fn(...args);
    };
    this.room.onStateChange(live(() => this.onPatch()));
    this.room.onMessage(MSG_KILL, live((msg: KillMessage) => this.hud.kill(msg)));
    this.room.onMessage(MSG_NOTICE, live((text: string) => this.hud.notice(text)));
    this.room.onMessage(MSG_HIT, live((msg: HitMessage) => this.onHit(msg)));
    this.room.onMessage(MSG_STATS, live((msg: StatsMessage) => this.onStats(msg)));
    this.room.onMessage(MSG_SPECTATE, live((msg: SpectateMessage) => this.onSpectate(msg)));
    this.room.onMessage(MSG_MATCH_END, live((msg: MatchEndMessage) => this.onMatchEnd(msg)));
    this.room.onMessage(MSG_WEB3, live((msg: Web3Notice) => this.hud.web3Save(msg, explorerTxUrl(msg.txHashes[0] ?? ""))));
    this.room.onDrop(live(() => this.hud.showBanner({ title: "Connection lost", sub: "Reconnecting…" })));
    this.room.onReconnect(live(() => this.hud.hideBanner()));
    this.room.onLeave(live(() => this.hud.showBanner({ title: "Disconnected", playAgain: true })));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.dispose());

    const ping = () => this.room.ping(live((ms: number) => {
      this.hud.setPing(ms);
      this.room.send(MSG_LATENCY, ms);
    }));
    ping();
    this.time.addEvent({ delay: 2000, loop: true, callback: ping });

    this.onPatch();
  }

  /** Zoom out on small screens so phones see about as much of the map as a laptop. */
  private fitZoom() {
    const { width, height } = this.scale.gameSize;
    this.cameras.main.setZoom(Math.min(1, Math.max(0.55, Math.min(width / 1280, height / 720))));
  }

  /** Stop reacting to the room. Phaser destroys scenes a frame late, so call this first. */
  dispose() {
    this.disposed = true;
    this.setAiming(false);
  }

  /** For the in-game menu: stop game input and let keys reach the menu's fields. */
  setPaused(paused: boolean) {
    this.paused = paused;
    const kb = this.input?.keyboard;
    if (!kb) return;
    kb.enabled = !paused;
    if (paused) {
      kb.disableGlobalCapture();
      kb.resetKeys();
    } else {
      kb.enableGlobalCapture();
    }
  }

  /** Switch to the other weapon slot (also used by the touch Swap button). */
  swapWeapon() {
    this.selectSlot(1 - this.wantSlot);
  }

  update(_time: number, delta: number) {
    if (this.disposed) return;
    this.accumulator = Math.min(this.accumulator + delta, TICK_MS * MAX_CATCHUP_STEPS);
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.localStep();
    }

    this.renderSelf(delta);
    this.renderOthers();
    this.renderBullets(delta);
    this.renderPlane();
    this.renderZone();
    this.renderCover(delta);
    this.updateCamera();
    this.renderCrosshair();
    this.updateHud();
  }

  // ---- Input and networking ---------------------------------------------

  /** Runs once per fixed step: sample input, predict, send. */
  private localStep() {
    const me = this.me();
    if (!me || !me.alive) return;

    const k = this.keys;
    let keys = this.paused ? 0 : this.touch?.keys() ?? 0;
    if (k.W.isDown || k.UP.isDown) keys |= KEY_UP;
    if (k.S.isDown || k.DOWN.isDown) keys |= KEY_DOWN;
    if (k.A.isDown || k.LEFT.isDown) keys |= KEY_LEFT;
    if (k.D.isDown || k.RIGHT.isDown) keys |= KEY_RIGHT;
    // JustDown also catches taps that started and ended since the last tick.
    const pressed = (key: Phaser.Input.Keyboard.Key) => Phaser.Input.Keyboard.JustDown(key) || key.isDown;
    if (pressed(k.E)) keys |= KEY_INTERACT;
    if (pressed(k.R)) keys |= KEY_RELOAD;
    if (pressed(k.H)) keys |= KEY_HEAL;
    const jump = pressed(k.SPACE);

    const mouseDown = !this.paused && !this.touch && this.input.activePointer.leftButtonDown();
    if (me.inPlane) {
      if (jump || mouseDown) keys |= KEY_JUMP;
      this.room.send(MSG_INPUT, { seq: ++this.seq, keys, angle: this.aim, fire: false, slot: this.wantSlot } satisfies InputMessage);
      return;
    }
    if (!this.spawned) return;

    const input: InputMessage = {
      seq: ++this.seq,
      keys,
      angle: this.aim,
      fire: this.touch ? this.touch.firing() : mouseDown,
      slot: this.wantSlot,
    };
    this.prevPred.x = this.pred.x;
    this.prevPred.y = this.pred.y;
    stepPlayer(this.pred, keys, this.geo);
    this.pending.push(input);
    this.room.send(MSG_INPUT, input);
  }

  private selectSlot(slot: number) {
    const me = this.me();
    if (me && weaponIn(me, slot) !== WEAPON_NONE) this.wantSlot = slot;
  }

  private spectateNextIfDead() {
    const me = this.me();
    if (me && this.watching(me)) this.room.send(MSG_SPECTATE_NEXT);
  }

  /** Looking through someone else's eyes: out of the match, or a spectator (also in the lobby). */
  private watching(me: Player) {
    return !me.alive && (me.spectator || this.room.state.phase !== PHASE_LOBBY);
  }

  /** A watcher with nobody to watch during the drop (everyone's aboard) follows the plane. */
  private watchingPlane(me: Player) {
    return this.watching(me) && this.room.state.phase === PHASE_DROP && !this.views.has(this.spectateId);
  }

  private onPatch() {
    const state = this.room.state;
    if (!state.players) return;
    const now = performance.now();

    if (!this.mapLoaded && state.rocks.length > 0) this.loadMap();
    if (state.phase !== this.lastPhase) this.onPhaseChange(state.phase);
    if (state.plane.t !== this.planeT.value) this.planeT = { value: state.plane.t, at: now };

    this.seen.clear();
    state.players.forEach((p, sid) => {
      this.seen.add(sid);
      const view = this.views.get(sid) ?? this.createPlayerView(sid, p);
      if (p.hp < view.lastHp && p.alive) this.flash(view);
      if (view.lastAlive && !p.alive) this.deathBurst(view.root.x, view.root.y, view.color);
      view.lastHp = p.hp;
      view.lastAlive = p.alive;
      if (sid === this.room.sessionId) {
        this.reconcile(p);
        this.trackOwnState(p);
      } else {
        view.buffer.push({ t: now, x: p.x, y: p.y, angle: p.angle, alive: p.alive && !p.inPlane });
      }
    });
    for (const [sid, view] of this.views) {
      if (this.seen.has(sid)) continue;
      view.root.destroy();
      this.views.delete(sid);
    }

    this.syncBullets();
    this.syncLoot();
    this.syncCrates();
  }

  /** Rewind to the server's position and replay the inputs it hasn't applied yet. */
  private reconcile(me: Player) {
    if (!me.alive || me.inPlane || !this.spawned) {
      this.pending.length = 0;
      this.pred.x = this.prevPred.x = me.x;
      this.pred.y = this.prevPred.y = me.y;
      this.correction.x = this.correction.y = 0;
      this.spawned = me.alive && !me.inPlane;
      return;
    }

    let drop = 0;
    while (drop < this.pending.length && this.pending[drop].seq <= me.lastSeq) drop++;
    if (drop > 0) this.pending.splice(0, drop);

    const oldX = this.pred.x;
    const oldY = this.pred.y;
    this.pred.x = me.x;
    this.pred.y = me.y;
    for (const input of this.pending) stepPlayer(this.pred, input.keys, this.geo);

    // Hide small mispredictions by easing them out over a few frames.
    const ex = oldX - this.pred.x;
    const ey = oldY - this.pred.y;
    this.prevPred.x -= ex;
    this.prevPred.y -= ey;
    this.correction.x += ex;
    this.correction.y += ey;
    if (Math.hypot(this.correction.x, this.correction.y) > SNAP_DISTANCE) {
      this.correction.x = this.correction.y = 0;
      this.prevPred.x = this.pred.x;
      this.prevPred.y = this.pred.y;
    }
  }

  /** Sounds, effects and slot bookkeeping driven by changes to our own player. */
  private trackOwnState(p: Player) {
    const m = this.mine;
    const now = snapshotOwnState(p);
    this.mine = now;
    if (!m) return;
    if (p.hp < m.hp && p.alive) {
      this.sfx.hurt();
      this.cameras.main.shake(120, 0.006);
    }
    const gained = p.armor > m.armor || p.medkits > m.medkits || p.w0 !== m.w0 || p.w1 !== m.w1
      || p.res0 > m.res0 || p.res1 > m.res1 || (p.hp > m.hp && m.healing);
    if (gained && p.alive && !p.inPlane) this.sfx.pickup();
    if ((p.reloading && !m.reloading) || (p.healing && !m.healing)) this.actionStart = performance.now();
    if (!p.reloading && m.reloading && p.alive) this.sfx.reload();
    if (m.inPlane && !p.inPlane && p.alive) {
      this.sfx.whoosh();
      const view = this.views.get(this.room.sessionId);
      if (view) this.landingEffect(view.root);
    }
    // The server moved us to another slot (e.g. picking up into the empty one): follow it.
    if (p.slot !== m.slot) this.wantSlot = p.slot;
  }

  private syncBullets() {
    const state = this.room.state;
    // One sound and muzzle flash per shooter per patch, however many pellets.
    const shooters = new Map<string, { weapon: number; x: number; y: number }>();
    state.bullets.forEach((b, id) => {
      if (this.bullets.has(id)) return;
      const weapon = WEAPONS[b.weapon] ?? WEAPONS[0];
      const dx = Math.cos(b.angle);
      const dy = Math.sin(b.angle);
      const hit = firstSolidHit(this.geo, b.x, b.y, b.x + dx * weapon.range, b.y + dy * weapon.range, BULLET_RADIUS);
      const obj = this.bulletPool.pop() ?? this.add.circle(0, 0, BULLET_RADIUS, 0xffffff).setDepth(DEPTH.bullet);
      obj.setPosition(b.x, b.y).setFillStyle(weapon.color).setVisible(true);
      this.bullets.set(id, {
        obj, x: b.x, y: b.y, dx, dy, speed: weapon.speed, traveled: 0,
        maxTravel: hit >= 0 ? hit * weapon.range : weapon.range,
      });
      if (!shooters.has(b.owner)) shooters.set(b.owner, { weapon: b.weapon, x: b.x, y: b.y });
    });
    for (const [id, bullet] of this.bullets) {
      if (!state.bullets.has(id)) this.releaseBullet(id, bullet);
    }
    const ear = this.cameras.main.midPoint;
    for (const [owner, shot] of shooters) {
      this.muzzleFlash(shot.x, shot.y);
      const d = owner === this.room.sessionId ? 0 : Math.hypot(shot.x - ear.x, shot.y - ear.y);
      this.sfx.shot(shot.weapon, 1 - d / HEARING_RANGE);
    }
  }

  /** Bullets are pooled: shotguns alone would otherwise create seven objects per shot. */
  private releaseBullet(id: string, bullet: BulletView) {
    bullet.obj.setVisible(false);
    this.bulletPool.push(bullet.obj);
    this.bullets.delete(id);
  }

  private syncLoot() {
    const state = this.room.state;
    state.loot.forEach((l, id) => {
      if (!this.lootViews.has(id)) this.lootViews.set(id, this.createLootView(l));
    });
    for (const [id, view] of this.lootViews) {
      if (state.loot.has(id)) continue;
      view.destroy();
      this.lootViews.delete(id);
    }
  }

  private syncCrates() {
    const state = this.room.state;
    let changed = false;
    state.crates.forEach((c, id) => {
      const view = this.crateViews.get(id);
      if (!view) {
        this.crateViews.set(id, { obj: this.createCrateView(c.x, c.y), hp: c.hp });
        changed = true;
      } else if (c.hp < view.hp) {
        view.hp = c.hp;
        this.tweens.add({ targets: view.obj, scale: { from: 0.9, to: 1 }, duration: 120 });
      }
    });
    for (const [id, view] of this.crateViews) {
      if (state.crates.has(id)) continue;
      const { x, y } = view.obj;
      view.obj.destroy();
      this.crateViews.delete(id);
      if (this.lastPhase !== PHASE_LOBBY) {
        this.burst(x, y, 0xa0743c, 10);
        this.sfx.crateBreak();
      }
      changed = true;
    }
    if (changed) {
      // Prediction must collide with exactly the crates the server still has.
      const crates: CrateRect[] = [];
      state.crates.forEach((c, id) => crates.push({ id, x: c.x, y: c.y, w: CRATE_SIZE, h: CRATE_SIZE }));
      this.geo = { ...this.geo, crates };
    }
  }

  private onPhaseChange(phase: string) {
    this.lastPhase = phase;
    if (phase === PHASE_LOBBY || phase === PHASE_DROP) {
      this.hud.hideBanner();
      // A spectator keeps watching; the server may already have sent the next target.
      if (!this.me()?.spectator) this.spectateId = "";
      this.stats = null;
      this.wantSlot = 0;
    }
    // Inventories get reset between phases; don't play pickup sounds for that.
    const me = this.me();
    if (me) this.mine = snapshotOwnState(me);
  }

  private onHit(msg: HitMessage) {
    this.hitMarkerUntil = performance.now() + HIT_MARKER_MS;
    if (msg.kill) this.sfx.kill();
    else this.sfx.hit();
    const text = this.add.text(msg.x + (Math.random() * 20 - 10), msg.y - PLAYER_RADIUS - 6, String(msg.damage), {
      fontFamily: "system-ui, sans-serif",
      fontSize: msg.kill ? "22px" : "16px",
      fontStyle: "bold",
      color: msg.kill ? "#ff5252" : "#ffffff",
      stroke: "#000000",
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(DEPTH.effect);
    this.tweens.add({ targets: text, y: text.y - 36, alpha: 0, duration: 700, ease: "Cubic.easeOut", onComplete: () => text.destroy() });
  }

  private onStats(msg: StatsMessage) {
    this.stats = msg;
    recordMatch(msg);
    if (msg.place === 1) return; // the match-end banner covers winning
    this.sfx.eliminated();
    this.hud.showBanner({
      title: `You placed #${msg.place}`,
      sub: msg.killer ? `Eliminated by ${msg.killer}` : "Caught by the zone",
      stats: msg,
      playAgain: true,
      hint: this.spectateHint(),
    });
  }

  private onSpectate(msg: SpectateMessage) {
    this.spectateId = msg.id;
    if (this.hud.bannerVisible) this.hud.setBannerHint(this.spectateHint(msg.name));
  }

  private spectateHint(name = this.room.state.players.get(this.spectateId)?.name) {
    const action = this.touch ? "Tap" : "Click or press Space";
    return name ? `Watching ${name} · ${action} for the next player` : "";
  }

  private onMatchEnd(msg: MatchEndMessage) {
    const won = msg.winnerId === this.room.sessionId;
    if (won) this.sfx.victory();
    this.hud.showBanner({
      title: won ? "Winner winner!" : `${msg.winner || "Nobody"} wins`,
      sub: won ? "You're the last one standing" : "Next match starts shortly",
      stats: this.stats,
      leaderboard: msg.leaderboard,
    });
  }

  // ---- Rendering --------------------------------------------------------

  private renderSelf(delta: number) {
    const me = this.me();
    const view = this.views.get(this.room.sessionId);
    if (!me || !view) return;

    const decay = Math.exp((-CORRECTION_DECAY * delta) / 1000);
    this.correction.x *= decay;
    this.correction.y *= decay;

    const alpha = this.accumulator / TICK_MS;
    const x = this.prevPred.x + (this.pred.x - this.prevPred.x) * alpha + this.correction.x;
    const y = this.prevPred.y + (this.pred.y - this.prevPred.y) * alpha + this.correction.y;
    const onGround = me.alive && !me.inPlane;
    view.root.setPosition(x, y).setVisible(onGround);
    if (onGround) {
      this.renderPos.x = x;
      this.renderPos.y = y;
    }

    const touchAim = this.touch?.aim();
    if (touchAim != null) {
      this.aim = touchAim;
    } else if (!this.touch) {
      const pointer = this.input.activePointer;
      const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.aim = Math.atan2(world.y - y, world.x - x);
    }
    view.gun.rotation = this.aim;
  }

  /** Draw other players slightly in the past, between two known snapshots. */
  private renderOthers() {
    const t = performance.now() - INTERP_DELAY_MS;
    for (const [sid, view] of this.views) {
      if (sid === this.room.sessionId) continue;
      const buf = view.buffer;
      while (buf.length > 2 && buf[1].t <= t) buf.shift();
      if (buf.length === 0) continue;

      const a = buf[0];
      const b = buf[1];
      if (!b || t <= a.t) {
        view.root.setPosition(a.x, a.y).setVisible(a.alive);
        view.gun.rotation = a.angle;
        continue;
      }
      const f = Math.min(1, (t - a.t) / (b.t - a.t));
      view.root
        .setPosition(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)
        // Hidden across deaths and teleports so they don't slide across the map.
        .setVisible(a.alive && b.alive);
      view.gun.rotation = lerpAngle(a.angle, b.angle, f);
    }
  }

  private renderBullets(delta: number) {
    for (const [id, b] of this.bullets) {
      const step = (b.speed * delta) / 1000;
      b.traveled += step;
      if (b.traveled >= b.maxTravel) {
        this.releaseBullet(id, b);
        continue;
      }
      b.x += b.dx * step;
      b.y += b.dy * step;
      b.obj.setPosition(b.x, b.y);
    }
  }

  private renderPlane() {
    const state = this.room.state;
    const flying = state.phase === PHASE_DROP;
    this.plane.setVisible(flying);
    if (!flying) return;
    const p = state.plane;
    const t = this.currentPlaneT();
    this.plane.setPosition(p.x0 + (p.x1 - p.x0) * t, p.y0 + (p.y1 - p.y0) * t);
    this.plane.rotation = Math.atan2(p.y1 - p.y0, p.x1 - p.x0);
  }

  /** The plane's progress, extrapolated between server updates so it glides smoothly. */
  private currentPlaneT() {
    const since = (performance.now() - this.planeT.at) / 1000;
    return Math.min(1, this.planeT.value + Math.min(since, 0.1) / DROP_SECONDS);
  }

  private renderZone() {
    const g = this.zoneGfx;
    g.clear();
    const phase = this.room.state.phase;
    if (phase === PHASE_LOBBY || phase === PHASE_DROP) return;
    const z = this.room.state.zone;
    g.fillStyle(ZONE_FOG, 0.35).fillPoints(fogPolygon(z.x, z.y, z.r), true);
    g.lineStyle(4, 0xffffff, 0.85).strokeCircle(z.x, z.y, z.r);
    if (z.tr < z.r - 1) g.lineStyle(2, 0xffffff, 0.45).strokeCircle(z.tx, z.ty, z.tr);
  }

  /** Roofs and bushes go see-through when the player you're looking through is under them. */
  private renderCover(delta: number) {
    const eye = this.eyePosition();
    const blend = 1 - Math.exp(-delta / 90);
    const roofIndex = eye ? inRects(this.geo.buildings, eye.x, eye.y) : -1;
    this.roofs.forEach((roof, i) => {
      const target = i === roofIndex ? 0.1 : 1;
      roof.alpha += (target - roof.alpha) * blend;
    });
    const bushIndex = eye ? inCircles(this.geo.bushes, eye.x, eye.y) : -1;
    this.bushViews.forEach((bush, i) => bush.setAlpha(i === bushIndex ? 0.5 : 0.92));
  }

  /** Where the camera's subject is: us, the plane, or our spectate target. */
  private eyePosition(): { x: number; y: number } | null {
    const me = this.me();
    if (!me) return null;
    if (me.inPlane || this.watchingPlane(me)) return { x: this.plane.x, y: this.plane.y };
    if (!this.watching(me)) return this.renderPos;
    const followed = this.views.get(this.spectateId)?.root;
    return followed ? { x: followed.x, y: followed.y } : null;
  }

  /** Follow yourself, the plane, or whoever you're spectating. */
  private updateCamera() {
    const me = this.me();
    if (!me) return;
    let id = this.room.sessionId;
    let target = this.views.get(id)?.root;
    if (me.inPlane || this.watchingPlane(me)) {
      id = "plane";
      target = this.plane;
    } else if (this.watching(me) && this.views.has(this.spectateId)) {
      id = this.spectateId;
      target = this.views.get(id)!.root;
    }
    if (!target || id === this.followId) return;
    this.followId = id;
    const lerp = id === this.spectateId ? SPECTATE_CAMERA_LERP : 1;
    this.cameras.main.startFollow(target, true, lerp, lerp);
  }

  private renderCrosshair() {
    const g = this.crosshair;
    g.clear();
    const me = this.me();
    this.setAiming(!this.touch && !!me?.alive && !me.inPlane);
    if (!this.aiming) return;
    const pointer = this.input.activePointer;
    const { x, y } = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const hit = performance.now() < this.hitMarkerUntil;
    g.lineStyle(2, hit ? 0xff4040 : 0xffffff, 0.9);
    g.strokeCircle(x, y, 9);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.lineBetween(x + dx * 5, y + dy * 5, x + dx * 14, y + dy * 14);
    if (hit) {
      g.lineStyle(3, 0xff4040, 1);
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) g.lineBetween(x + dx * 6, y + dy * 6, x + dx * 12, y + dy * 12);
    }
  }

  /** The mouse cursor is hidden only while the crosshair replaces it (not when dead or in the plane). */
  private setAiming(on: boolean) {
    if (on === this.aiming) return;
    this.aiming = on;
    document.body.classList.toggle("aiming", on);
  }

  private updateHud() {
    const state = this.room.state;
    const me = this.me();
    if (!me) return;
    const onGround = me.alive && !me.inPlane;
    this.hud.setStats(state.aliveCount, me.kills);
    this.hud.setSpectator(me.spectator);
    this.hud.setHp(me.alive ? me.hp : 0);
    this.hud.setArmor(me.alive ? me.armor : 0);
    this.hud.setMedkits(me.medkits);
    for (const slot of [0, 1]) {
      const w = weaponIn(me, slot);
      const weapon = WEAPONS[w];
      this.hud.setSlot(slot, {
        name: weapon?.name ?? "",
        ammo: weapon ? `${magIn(me, slot)} / ${weapon.reserve === 0 ? "∞" : reserveIn(me, slot)}` : "",
        active: slot === me.slot && w !== WEAPON_NONE,
        empty: w === WEAPON_NONE,
      });
    }
    const elapsed = performance.now() - this.actionStart;
    if (me.reloading) this.hud.setAction("Reloading", elapsed / (WEAPONS[weaponIn(me, me.slot)].reloadTicks * TICK_MS));
    else if (me.healing) this.hud.setAction("Healing", elapsed / (MEDKIT_TICKS * TICK_MS));
    else this.hud.setAction("", 0);

    const z = state.zone;
    const outside = onGround && state.phase === PHASE_PLAYING && Math.hypot(me.x - z.x, me.y - z.y) > z.r;
    let status = "";
    if (state.phase === PHASE_LOBBY) {
      status = `Match starts in ${state.timer}s · ${state.playerCount} players · ${state.difficulty} bots`;
    } else if (state.phase === PHASE_DROP) {
      status = me.inPlane ? `Auto-drop in ${state.timer}s` : `Zone appears in ${state.timer}s`;
    } else if (state.phase === PHASE_PLAYING) {
      status = z.shrinking ? `Zone closing · ${state.timer}s` : state.timer > 0 ? `Zone shrinks in ${state.timer}s` : "Final zone";
      if (outside) status = `Outside the zone! ${status}`;
    } else if (state.phase === PHASE_ENDED) {
      status = `Next match in ${state.timer}s`;
    }
    this.hud.setStatus(status, outside);
    this.hud.setPrompt(this.prompt(me));
    this.touch?.show(me.alive && state.phase !== PHASE_ENDED);
    this.touch?.setMode(me.inPlane);

    const followed = this.views.get(this.spectateId)?.root;
    this.minimap.draw(state, onGround ? this.renderPos : me.inPlane ? null : followed ?? null, PLAYER_COLORS[me.color], {
      zone: state.phase === PHASE_PLAYING || state.phase === PHASE_ENDED,
      planeT: state.phase === PHASE_DROP ? this.currentPlaneT() : null,
    });
  }

  private prompt(me: Player): string {
    const touch = !!this.touch;
    const phase = this.room.state.phase;
    const running = phase === PHASE_PLAYING || phase === PHASE_DROP;
    if (me.spectator) return [`Spectating${touch ? "" : " · Esc to play"}`, this.spectateHint()].filter(Boolean).join(". ");
    // Dead without an elimination: we joined mid-match and are spectating.
    if (!me.alive) return running && !this.stats ? `Match in progress · you'll play the next one. ${this.spectateHint()}` : "";
    if (me.inPlane) return touch ? "Tap Jump to drop" : "Space or click to jump";
    if (!running) return "";
    const loot = this.nearestWeaponLoot();
    if (loot) {
      const full = me.w0 !== WEAPON_NONE && me.w1 !== WEAPON_NONE;
      return `${touch ? "Pick up" : "E: pick up"} ${WEAPONS[loot.type].name}${full ? " (swaps with your current weapon)" : ""}`;
    }
    const w = weaponIn(me, me.slot);
    if (w !== WEAPON_NONE && magIn(me, me.slot) === 0 && !me.reloading) {
      return WEAPONS[w].reserve === 0 || reserveIn(me, me.slot) > 0 ? (touch ? "Reload" : "R: reload") : "Out of ammo";
    }
    if (me.medkits > 0 && me.hp < MAX_HEALTH - 20 && !me.healing) return touch ? "Heal" : "H: use medkit";
    return "";
  }

  private nearestWeaponLoot(): Loot | null {
    let best: Loot | null = null;
    let bestD = PICKUP_RADIUS * PICKUP_RADIUS;
    this.room.state.loot.forEach((l) => {
      if (!isWeaponLoot(l.type)) return;
      const d = (l.x - this.renderPos.x) ** 2 + (l.y - this.renderPos.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = l;
      }
    });
    return best;
  }

  // ---- Effects ----------------------------------------------------------

  private flash(view: PlayerView) {
    // White flash, unless the player is already near-white.
    view.body.setFillStyle(luminance(view.color) > 0.8 ? 0xff3030 : 0xffffff);
    this.time.delayedCall(80, () => view.body.setFillStyle(view.color));
  }

  private muzzleFlash(x: number, y: number) {
    const f = this.add.circle(x, y, 9, 0xfff2a8, 0.9).setDepth(DEPTH.flash);
    this.tweens.add({ targets: f, alpha: 0, scale: 1.7, duration: 90, onComplete: () => f.destroy() });
  }

  private deathBurst(x: number, y: number, color: number) {
    this.burst(x, y, color, 14);
    const ring = this.add.circle(x, y, PLAYER_RADIUS, 0xffffff, 0).setStrokeStyle(3, color, 1).setDepth(DEPTH.effect);
    this.tweens.add({ targets: ring, scale: 2.4, alpha: 0, duration: 450, onComplete: () => ring.destroy() });
  }

  private burst(x: number, y: number, color: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 25 + Math.random() * 35;
      const piece = this.add.circle(x, y, 3 + Math.random() * 3, color).setDepth(DEPTH.effect);
      this.tweens.add({
        targets: piece, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, alpha: 0, scale: 0.3,
        duration: 400 + Math.random() * 200, ease: "Cubic.easeOut", onComplete: () => piece.destroy(),
      });
    }
  }

  private landingEffect(target: Phaser.GameObjects.Container) {
    this.tweens.add({ targets: target, scale: { from: 2, to: 1 }, alpha: { from: 0.4, to: 1 }, duration: 450, ease: "Cubic.easeOut" });
  }

  // ---- Object factories -------------------------------------------------

  private createPlayerView(sid: string, p: Player): PlayerView {
    const isMe = sid === this.room.sessionId;
    const barrel = this.add.rectangle(PLAYER_RADIUS + 4, 0, 18, 8, 0x2b2b2b);
    const gun = this.add.container(0, 0, [barrel]);
    const color = PLAYER_COLORS[p.color] ?? 0xffffff;
    const body = this.add.circle(0, 0, PLAYER_RADIUS, color);
    // A white ring marks you; everyone else gets a soft dark outline.
    if (isMe) body.setStrokeStyle(4, 0xffffff, 1);
    else body.setStrokeStyle(3, 0x000000, 0.4);
    const label = this.add.text(0, -PLAYER_RADIUS - 14, p.name, {
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 3,
    }).setOrigin(0.5);
    const root = this.add.container(p.x, p.y, [gun, body, label]).setDepth(DEPTH.player);
    // Someone appearing mid-drop has just landed.
    if (!isMe && this.room.state.phase === PHASE_DROP) this.landingEffect(root);

    const view: PlayerView = { root, gun, body, color, buffer: [], lastHp: p.hp, lastAlive: p.alive };
    this.views.set(sid, view);
    return view;
  }

  private createLootView(l: Loot): Phaser.GameObjects.Container {
    const parts: Phaser.GameObjects.GameObject[] = [];
    if (isWeaponLoot(l.type)) {
      const w = WEAPONS[l.type];
      parts.push(
        this.add.rectangle(0, 0, 32, 14, w.color).setStrokeStyle(2, 0x000000, 0.6),
        this.add.text(0, -16, w.name, {
          fontFamily: "system-ui, sans-serif", fontSize: "11px", color: "#ffffff", stroke: "#000000", strokeThickness: 3,
        }).setOrigin(0.5),
      );
    } else if (l.type === LOOT_MEDKIT) {
      parts.push(
        this.add.rectangle(0, 0, 20, 20, 0xffffff).setStrokeStyle(2, 0x000000, 0.5),
        this.add.rectangle(0, 0, 12, 4, 0xe53935),
        this.add.rectangle(0, 0, 4, 12, 0xe53935),
      );
    } else if (l.type === LOOT_ARMOR) {
      parts.push(
        this.add.circle(0, 0, 11, 0x5aa9e6).setStrokeStyle(2, 0x000000, 0.5),
        this.add.circle(0, 0, 5, 0xd6ecff),
      );
    } else if (l.type === LOOT_AMMO) {
      parts.push(
        this.add.rectangle(-4, 0, 7, 14, 0xd4b44a).setStrokeStyle(1, 0x000000, 0.6),
        this.add.rectangle(5, 0, 7, 14, 0xd4b44a).setStrokeStyle(1, 0x000000, 0.6),
      );
    }
    return this.add.container(l.x, l.y, parts).setDepth(DEPTH.loot);
  }

  private createCrateView(x: number, y: number): Phaser.GameObjects.Container {
    const s = CRATE_SIZE;
    return this.add.container(x + s / 2, y + s / 2, [
      this.add.rectangle(0, 0, s, s, 0xa0743c).setStrokeStyle(3, 0x5c3d1a),
      this.add.rectangle(0, 0, s - 14, s - 14).setStrokeStyle(2, 0x7a5528),
    ]).setDepth(DEPTH.solid);
  }

  private createPlane(): Phaser.GameObjects.Container {
    const body = this.add.triangle(0, 0, 40, 0, -30, -26, -30, 26, 0xeeeeee).setStrokeStyle(3, 0x333333);
    const shadow = this.add.triangle(18, 18, 40, 0, -30, -26, -30, 26, 0x000000, 0.25);
    return this.add.container(0, 0, [shadow, body]).setDepth(DEPTH.plane).setVisible(false);
  }

  private loadMap() {
    const state = this.room.state;
    const water = this.add.graphics().setDepth(DEPTH.water);
    state.ponds.forEach((p) => {
      water.fillStyle(0x3a6ea5, 0.95).fillCircle(p.x, p.y, p.r);
      water.lineStyle(4, 0x8fbbe0, 0.6).strokeCircle(p.x, p.y, p.r);
    });

    const floors = this.add.graphics().setDepth(DEPTH.floor);
    state.floors.forEach((f) => {
      floors.fillStyle(0x8a7a5c).fillRect(f.x, f.y, f.w, f.h);
    });

    const solid = this.add.graphics().setDepth(DEPTH.solid);
    const walls = state.walls.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
    for (const w of walls) solid.fillStyle(0x2f2f2f).fillRect(w.x, w.y, w.w, w.h);
    const rocks = state.rocks.map((r) => ({ x: r.x, y: r.y, r: r.r }));
    for (const r of rocks) {
      solid.fillStyle(0x7a7f73).fillCircle(r.x, r.y, r.r);
      solid.lineStyle(3, 0x4d5149).strokeCircle(r.x, r.y, r.r);
    }

    const bushes = state.bushes.map((b) => ({ x: b.x, y: b.y, r: b.r }));
    this.bushViews = bushes.map((b) => this.add.circle(b.x, b.y, b.r, 0x2e7d32, 0.92).setStrokeStyle(3, 0x1b5e20).setDepth(DEPTH.bush));

    const buildings = state.floors.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
    this.roofs = buildings.map((r) =>
      this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, 0x6b4f3a).setStrokeStyle(4, 0x3e2c20).setDepth(DEPTH.roof));

    this.geo = {
      rocks, walls, crates: this.geo.crates, water: state.ponds.map((p) => ({ x: p.x, y: p.y, r: p.r })),
      bushes, buildings,
    };
    this.minimap.setTerrain(state);
    this.mapLoaded = true;
  }

  private drawGround() {
    const g = this.add.graphics();
    g.fillStyle(0x3b5e3f).fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    g.lineStyle(1, 0x000000, 0.12);
    for (let i = 100; i < MAP_SIZE; i += 100) {
      g.lineBetween(i, 0, i, MAP_SIZE);
      g.lineBetween(0, i, MAP_SIZE, i);
    }
    g.lineStyle(6, 0x111811).strokeRect(0, 0, MAP_SIZE, MAP_SIZE);
  }

  private me(): Player | undefined {
    return this.room.state.players?.get(this.room.sessionId);
  }
}

function snapshotOwnState(p: Player): OwnState {
  return {
    hp: p.hp, armor: p.armor, medkits: p.medkits, w0: p.w0, w1: p.w1, res0: p.res0, res1: p.res1,
    slot: p.slot, reloading: p.reloading, healing: p.healing, inPlane: p.inPlane,
  };
}

const FOG_MARGIN = 2000;
const FOG_SEGMENTS = 72;

/**
 * Everything outside the circle as one "keyhole" polygon: the outer box, a
 * zero-width cut in to the circle, and the circle traced backwards. A single
 * polygon keeps the fog's transparency even (overlapping shapes would stack).
 */
function fogPolygon(cx: number, cy: number, r: number): Phaser.Math.Vector2[] {
  const lo = -FOG_MARGIN;
  const hi = MAP_SIZE + FOG_MARGIN;
  const V = Phaser.Math.Vector2;
  const pts = [new V(lo, cy), new V(lo, lo), new V(hi, lo), new V(hi, hi), new V(lo, hi), new V(lo, cy)];
  if (r > 1) {
    for (let i = 0; i <= FOG_SEGMENTS; i++) {
      const a = Math.PI + (i / FOG_SEGMENTS) * Math.PI * 2;
      pts.push(new V(cx + Math.cos(a) * r, cy - Math.sin(a) * r));
    }
  }
  return pts;
}

function luminance(color: number): number {
  return (0.2126 * ((color >> 16) & 0xff) + 0.7152 * ((color >> 8) & 0xff) + 0.0722 * (color & 0xff)) / 255;
}

function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
