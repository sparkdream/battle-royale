import { randomBytes } from "node:crypto";
import { type Client, Room, ServerError } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import {
  ARMOR_ABSORB, BULLET_RADIUS, Bullet, CRATE_SIZE, DIFFICULTIES, DROP_SECONDS, type Difficulty,
  ENDED_SECONDS, ERR_SERVER_FULL, GameState, type HitMessage, INTERP_DELAY_MS, type InputMessage, type JoinOptions,
  KEY_HEAL, KEY_INTERACT, KEY_JUMP, KEY_MASK, KEY_RELOAD, type KillMessage, LAG_COMP_MAX_MS,
  LOBBY_SECONDS, LOOT_AMMO, LOOT_ARMOR, LOOT_MEDKIT, MAP_SIZE, MAX_ARMOR, MAX_HEALTH, MAX_MEDKITS,
  MAX_PLAYERS, MEDKIT_HEAL, MEDKIT_TICKS, MIN_PLAYERS_TO_START, MSG_HIT, MSG_INPUT, MSG_KILL,
  MSG_LATENCY, MSG_MATCH_END, MSG_NOTICE, MSG_SETTINGS, MSG_SPECTATE, MSG_SPECTATE_NEXT, MSG_STATS, MSG_WEB3, MUZZLE_OFFSET,
  type MatchEndMessage, type MatchEntry, type MatchParticipant, type MatchRecord, PHASE_DROP, PHASE_ENDED, PHASE_LOBBY, PHASE_PLAYING, PICKUP_RADIUS,
  PLAYER_COLORS, PLAYER_RADIUS, Player, RECONNECT_SECONDS, type SettingsMessage, type SpectateMessage, type StatsMessage,
  TICK_DT, TICK_MS, TICK_RATE, WEAPONS, WEAPON_NONE, WEAPON_PISTOL, type Weapon, activeWeapon,
  ammoPickupAmount, ammoTarget, canSee, circleBlocked, giveWeapon, isWeaponLoot, magIn, maxReserve,
  raycastSolid, reserveIn, resetInventory, segmentCircleHit, setMag, setReserve, setSlotContents,
  shortAddress, stepPlayer, weaponIn,
} from "@br/shared";
import { Bot, type BotWorld, SKILL, botName, randomPersonality } from "./Bot";
import { web3 } from "./chain";
import { addressAuth } from "./instance";
import { type MatchResult, profiles } from "./profiles";
import { type GeneratedMap, dropLoot, generateMap, randomLootType, randomSeed, resetCrates, spawnLoot } from "./map";
import { ZoneController } from "./ZoneController";

// Inputs applied per player per tick. Lets a client that stalled catch up a
// little without letting it move faster than everyone else.
const MAX_INPUTS_PER_TICK = 2;
// Each tick earns one input credit, banked up to this many; applying an input
// spends one. A catch-up burst only spends credit a stall left unused, so a
// client flooding inputs still moves at 1x on average.
const MAX_INPUT_CREDIT = TICK_RATE;
// Inputs that arrive in a burst after a network stall are buffered, not dropped:
// the client has already predicted them, so dropping one makes it snap back.
const MAX_QUEUED_INPUTS = TICK_RATE;

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const MAP_COUNTS = {
  rocks: env("OBSTACLE_COUNT", 110),
  buildings: env("BUILDING_COUNT", 10),
  ponds: env("POND_COUNT", 6),
  bushes: env("BUSH_COUNT", 45),
  crates: env("CRATE_COUNT", 35),
};
const OPEN_LOOT_COUNT = env("LOOT_COUNT", 90);
// Bots top the room up to this many combatants; each human who joins replaces one.
const BOT_FILL = env("BOT_FILL", 10);
const LOBBY_TICKS = env("LOBBY_SECONDS", LOBBY_SECONDS) * TICK_RATE;
const DROP_TICKS = Math.max(1, env("DROP_SECONDS", DROP_SECONDS) * TICK_RATE);
// > 1 speeds up the zone, for testing.
const MATCH_SPEED = env("MATCH_SPEED", 1);
// Games this process runs at once. All rooms share one CPU core, and a full one
// costs about 6% of it, so this keeps a public server from being swamped.
const MAX_ROOMS = env("MAX_ROOMS", 10);
let roomCount = 0;

// Position history for lag compensation, one slot per tick.
const HISTORY_TICKS = Math.ceil(LAG_COMP_MAX_MS / TICK_MS) + 2;

interface PlayerMeta {
  inputs: InputMessage[];
  inputCredit: number;
  lastQueuedSeq: number;
  /** Keys held in the last applied input, to detect presses. */
  prevKeys: number;
  /** Slot asked for in the last applied input; only a change counts as a switch request. */
  prevSlot: number;
  nextFireTick: number;
  reloadDoneTick: number;
  healDoneTick: number;
  zoneDamage: number; // fractional damage carried between ticks
  latencyMs: number;
  histX: Float32Array;
  histY: Float32Array;
  /** First tick with valid history (reset on teleport). */
  histFrom: number;
  damageDealt: number;
  spawnTick: number;
  /** Who a dead player is spectating. */
  watchId: string;
  /** Players currently in this client's StateView. */
  visible: Set<string>;
  /** The human's guest profile, where their results are recorded. "" for bots and players without one. */
  profileId: string;
  /** Spark Dream address proven at join; results are also recorded onchain against it. */
  address?: string;
  /** Loot types picked up this match. */
  collected: Map<number, number>;
  /** Crates broken this match. */
  crates: number;
}

interface BulletSim {
  owner: string;
  weapon: Weapon;
  x: number;
  y: number;
  dx: number;
  dy: number;
  traveled: number;
  /** How many ticks back to test targets, to match what the shooter saw. */
  rewind: number;
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = MAX_PLAYERS;

  /** The bots' current difficulty. `state.difficulty` is the chosen one, applied in the lobby. */
  private difficulty: Difficulty = "normal";
  private tick = 0;
  private phaseTicks = 0;
  private map!: GeneratedMap;
  private zone!: ZoneController;
  private meta = new Map<string, PlayerMeta>();
  private bullets = new Map<string, BulletSim>();
  private nextId = 0;
  private scratch = { x: 0, y: 0 };
  private bots = new Map<string, Bot>();
  private botsCreated = 0;
  private botWorld!: BotWorld;
  /** Who started the current match, for the funnel's humans-per-match count. */
  private matchHumans = 0;
  private matchBots = 0;
  /** Linked players' results this match, recorded onchain when it ends. */
  private matchEntries: MatchEntry[] = [];
  /** Everyone's result this match (bots too), in elimination order: the match record. */
  private matchLog: MatchParticipant[] = [];
  private matchId = "";
  private matchStartedAt = 0;
  private offNotice: () => void = () => {};

  onCreate(options?: JoinOptions) {
    // Rejects the create; joinOrCreate only creates when every room is full.
    if (roomCount >= MAX_ROOMS) throw new ServerError(ERR_SERVER_FULL, "The server is full. Try again in a minute.");
    roomCount++;
    const requested = options?.difficulty;
    this.difficulty = requested && DIFFICULTIES.includes(requested) ? requested : "normal";
    this.setState(new GameState());
    this.state.difficulty = this.difficulty;
    this.map = generateMap(this.state, MAP_COUNTS, () => this.newId(), randomSeed());
    this.zone = new ZoneController(this.state.zone, MATCH_SPEED);
    this.botWorld = {
      tick: 0, phase: PHASE_LOBBY, players: this.state.players, loot: this.state.loot,
      geo: this.map.geo, zone: this.state.zone, plane: this.state.plane,
    };

    // Onchain notices (post-match tx confirmations) go to whichever client
    // here plays under that address.
    this.offNotice = web3.onNotice((address, notice) => {
      for (const client of this.clients) {
        if (this.meta.get(client.sessionId)?.address === address) {
          client.send(MSG_WEB3, notice);
          return true;
        }
      }
      return false;
    });

    this.onMessage(MSG_INPUT, (client, msg: InputMessage) => this.queueInput(client, msg));
    this.onMessage(MSG_LATENCY, (client, ms: unknown) => {
      const meta = this.meta.get(client.sessionId);
      if (meta && typeof ms === "number" && Number.isFinite(ms)) meta.latencyMs = Math.max(0, Math.min(ms, 1000));
    });
    this.onMessage(MSG_SPECTATE_NEXT, (client) => this.spectateNext(client.sessionId));
    this.onMessage(MSG_SETTINGS, (client, msg: SettingsMessage) => this.changeSettings(client.sessionId, msg));

    this.setPatchRate(TICK_MS);
    this.setFixedTimestep(() => this.update(), TICK_RATE);
    this.enterLobby();
  }

  onJoin(client: Client, options?: JoinOptions) {
    const player = new Player();
    const profile = profiles.profile(options?.profile, options?.ref);
    // An address only comes from a ticket its owner earned by signing a login nonce just now.
    const address = addressAuth.addressFor(options?.ticket);
    const fallback = profile?.name || (address ? shortAddress(address) : `Player ${this.clients.length}`);
    player.name = this.pickName(client, profile?.id ?? "", sanitizeName(options?.name), fallback);
    player.spectator = options?.spectate === true;
    this.addPlayer(client.sessionId, player);
    const meta = this.meta.get(client.sessionId)!;
    meta.profileId = profile?.id ?? "";
    meta.address = address;
    // Arrived mid-match: spectate until the next lobby.
    if (this.state.phase !== PHASE_LOBBY) player.alive = false;
    client.view = new StateView();
    this.balanceBots();
  }

  onDrop(client: Client) {
    // Keep their player in the world for a while in case they come back.
    // Rejects if they don't make it back (or the room closes); onLeave handles that.
    this.allowReconnection(client, RECONNECT_SECONDS).catch(() => {});
  }

  onReconnect(client: Client) {
    client.view = new StateView();
    this.meta.get(client.sessionId)?.visible.clear();
  }

  onLeave(client: Client) {
    this.removePlayer(client.sessionId);
    this.balanceBots();
  }

  onDispose() {
    this.offNotice();
    roomCount--;
  }

  // ---- Match flow -------------------------------------------------------

  private enterLobby() {
    this.state.phase = PHASE_LOBBY;
    this.phaseTicks = LOBBY_TICKS;
    this.matchEntries = [];
    this.matchLog = [];
    this.matchId = "";
    this.zone.reset();
    this.clearBullets();
    this.state.loot.clear();
    resetCrates(this.state, this.map);
    this.state.players.forEach((p, id) => this.resetPlayer(id, p));
    this.applyDifficulty();
    this.balanceBots();
  }

  private startDrop() {
    if (this.combatants() < MIN_PLAYERS_TO_START) {
      this.phaseTicks = LOBBY_TICKS;
      return;
    }
    this.state.phase = PHASE_DROP;
    this.phaseTicks = DROP_TICKS;
    this.clearBullets();
    spawnLoot(this.state, this.map.geo, OPEN_LOOT_COUNT, () => this.newId());

    // A straight flight path across the map, passing near the middle.
    const a = Math.random() * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const offset = (Math.random() * 2 - 1) * MAP_SIZE * 0.15;
    const cx = MAP_SIZE / 2 - dy * offset;
    const cy = MAP_SIZE / 2 + dx * offset;
    const half = MAP_SIZE * 0.6;
    const plane = this.state.plane;
    plane.x0 = cx - dx * half;
    plane.y0 = cy - dy * half;
    plane.x1 = cx + dx * half;
    plane.y1 = cy + dy * half;
    plane.t = 0;

    this.matchHumans = this.matchBots = 0;
    this.matchId = randomBytes(8).toString("hex");
    this.matchStartedAt = Math.floor(Date.now() / 1000);
    this.matchEntries = [];
    this.matchLog = [];
    this.state.players.forEach((p, id) => {
      this.resetPlayer(id, p);
      if (p.spectator) return;
      if (p.bot) this.matchBots++;
      else this.matchHumans++;
      p.inPlane = true;
      p.x = plane.x0;
      p.y = plane.y0;
    });
  }

  private startPlaying() {
    this.state.players.forEach((p, id) => {
      if (p.inPlane) this.land(id, p);
    });
    this.state.phase = PHASE_PLAYING;
    this.zone.start();
  }

  private endMatch(winnerId: string | null) {
    this.state.phase = PHASE_ENDED;
    this.phaseTicks = ENDED_SECONDS * TICK_RATE;
    const winner = winnerId ? this.state.players.get(winnerId) : undefined;
    if (winnerId && winner) this.sendStats(winnerId, winner, 1, "");
    if (this.matchHumans > 0) profiles.recordMatch(this.matchHumans, this.matchBots);

    const leaderboard: MatchEndMessage["leaderboard"] = [];
    this.state.players.forEach((p) => {
      if (!p.spectator) leaderboard.push({ name: p.name, kills: p.kills });
    });
    leaderboard.sort((a, b) => b.kills - a.kills);
    this.broadcast(MSG_MATCH_END, {
      winner: winner?.name ?? "", winnerId: winnerId ?? "", leaderboard: leaderboard.slice(0, 5),
      matchId: this.matchHumans > 0 ? this.matchId : "",
    } satisfies MatchEndMessage);

    // The match record: kept for GET /matches/<id>, and anchored onchain by a
    // match token's uri hash when anyone in the match linked a wallet.
    const record: MatchRecord = {
      id: this.matchId,
      game: "battle-royale",
      map: { id: this.map.id, seed: this.map.seed },
      difficulty: this.difficulty,
      startedAt: this.matchStartedAt,
      endedAt: Math.floor(Date.now() / 1000),
      humans: this.matchHumans,
      bots: this.matchBots,
      winner: winner?.name ?? "",
      players: [...this.matchLog].sort((a, b) => a.place - b.place),
    };
    if (this.matchHumans > 0) profiles.storeMatch(record);

    // Onchain: careers, badges, the winner's map token and the match token
    // (when enabled and anyone in the match linked a wallet). Notices flow back via MSG_WEB3.
    if (web3.enabled && this.matchEntries.length > 0) {
      const entries = this.matchEntries;
      web3.recordMatch(record, entries).catch(() => {});
    }
  }

  /** From the in-game menu. Anyone can change the bots; that applies to everyone, from the lobby. */
  private changeSettings(id: string, msg: SettingsMessage) {
    const player = this.state.players.get(id);
    if (!player || typeof msg !== "object" || msg === null) return;
    const name = sanitizeName(msg.name);
    const client = this.clients.getById(id);
    if (name && name !== player.name && client) {
      player.name = this.pickName(client, this.meta.get(id)!.profileId, name, player.name);
    }
    const difficulty = msg.difficulty;
    if (difficulty && DIFFICULTIES.includes(difficulty) && difficulty !== this.state.difficulty) {
      this.state.difficulty = difficulty;
      const now = this.state.phase === PHASE_LOBBY;
      if (now) this.applyDifficulty();
      this.broadcast(MSG_NOTICE, `${player.name} set the bots to ${difficulty}${now ? "" : " from the next match"}`);
    }
    if (typeof msg.spectate === "boolean" && msg.spectate !== player.spectator) this.setSpectator(id, player, msg.spectate);
  }

  /**
   * The name a human ends up with: `wanted` if no other profile holds it (it
   * becomes their profile's), otherwise `fallback`, with a notice saying why.
   */
  private pickName(client: Client, profileId: string, wanted: string, fallback: string): string {
    if (!wanted) return fallback;
    if (profileId ? profiles.rename(profileId, wanted) : !profiles.nameTaken(wanted)) return wanted;
    client.send(MSG_NOTICE, `The name ${wanted} is taken`);
    return fallback;
  }

  /** Not while alive in a match: that would be a free way out of a losing fight. */
  private setSpectator(id: string, p: Player, on: boolean) {
    const phase = this.state.phase;
    if (p.alive && (phase === PHASE_DROP || phase === PHASE_PLAYING)) return;
    p.spectator = on;
    // In the lobby, step into or out of the crowd now; otherwise players come back at the next lobby.
    if (phase === PHASE_LOBBY) this.resetPlayer(id, p);
    else if (on) p.alive = false;
    this.balanceBots();
  }

  /** Players taking part in matches: everyone but spectators. */
  private combatants(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (!p.spectator) n++;
    });
    return n;
  }

  private applyDifficulty() {
    this.difficulty = this.state.difficulty as Difficulty;
    for (const bot of this.bots.values()) bot.skill = SKILL[this.difficulty];
  }

  private balanceBots() {
    // Bots can't drop into a match in progress; fix the count at the next lobby.
    if (this.state.phase !== PHASE_LOBBY) return;
    let humans = 0;
    let spectators = 0;
    this.state.players.forEach((p) => {
      if (p.spectator) spectators++;
      else if (!p.bot) humans++;
    });
    // Spectators on their own still get a bots-only match to watch.
    const wanted = humans + spectators === 0 ? 0 : Math.max(0, Math.min(BOT_FILL, MAX_PLAYERS) - humans);
    while (this.bots.size < wanted) {
      const id = `bot-${this.botsCreated}`;
      const player = new Player();
      player.name = botName(this.botsCreated++);
      player.bot = true;
      this.bots.set(id, new Bot(id, SKILL[this.difficulty], randomPersonality()));
      this.addPlayer(id, player);
    }
    for (const id of this.bots.keys()) {
      if (this.bots.size <= wanted) break;
      this.removePlayer(id);
    }
  }

  // ---- Players ----------------------------------------------------------

  private addPlayer(id: string, player: Player) {
    this.meta.set(id, {
      inputs: [], inputCredit: 0, lastQueuedSeq: 0, prevKeys: 0, prevSlot: 0, nextFireTick: 0, reloadDoneTick: 0, healDoneTick: 0,
      zoneDamage: 0, latencyMs: 0, histX: new Float32Array(HISTORY_TICKS), histY: new Float32Array(HISTORY_TICKS),
      histFrom: this.tick, damageDealt: 0, spawnTick: this.tick, watchId: "", visible: new Set(), profileId: "",
      collected: new Map(), crates: 0,
    });
    player.color = this.pickColor();
    this.state.players.set(id, player);
    this.resetPlayer(id, player);
  }

  private removePlayer(id: string) {
    // Leaving alive mid-match ends their match like an elimination would, so
    // their profile, the match record and their career all see it.
    const p = this.state.players.get(id);
    if (p && p.alive && !p.spectator && this.combat) {
      p.alive = false;
      let place = 1;
      this.state.players.forEach((other) => {
        if (other.alive) place++;
      });
      this.sendStats(id, p, place, "");
    }
    this.state.players.delete(id);
    this.meta.delete(id);
    this.bots.delete(id);
  }

  /** A random color among the least-used ones, so colors are unique until the palette runs out. */
  private pickColor(): number {
    const uses = PLAYER_COLORS.map(() => 0);
    this.state.players.forEach((p) => uses[p.color]++);
    const fewest = Math.min(...uses);
    const candidates = uses.flatMap((n, i) => (n === fewest ? [i] : []));
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private resetPlayer(id: string, p: Player) {
    p.hp = MAX_HEALTH;
    p.armor = 0;
    p.kills = 0;
    p.alive = !p.spectator;
    p.inPlane = false;
    resetInventory(p);
    this.placeAtSpawn(p);
    const meta = this.meta.get(id)!;
    meta.inputs.length = 0;
    meta.inputCredit = 0;
    meta.prevSlot = 0;
    meta.zoneDamage = 0;
    meta.nextFireTick = 0;
    meta.damageDealt = 0;
    meta.spawnTick = this.tick;
    meta.watchId = "";
    meta.histFrom = this.tick + 1;
    meta.collected.clear();
    meta.crates = 0;
  }

  private placeAtSpawn(player: Player) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = 60 + Math.random() * (MAP_SIZE - 120);
      const y = 60 + Math.random() * (MAP_SIZE - 120);
      if (!circleBlocked(this.map.geo, x, y, PLAYER_RADIUS + 4)) {
        player.x = x;
        player.y = y;
        return;
      }
    }
    player.x = MAP_SIZE / 2;
    player.y = MAP_SIZE / 2;
  }

  /** Jump out of the plane: land at the nearest free spot under it. */
  private land(id: string, p: Player) {
    p.inPlane = false;
    const x0 = Math.min(MAP_SIZE - 120, Math.max(120, p.x));
    const y0 = Math.min(MAP_SIZE - 120, Math.max(120, p.y));
    let x = x0;
    let y = y0;
    search: for (let r = 0; r <= 600; r += 30) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        x = x0 + Math.cos(a) * r;
        y = y0 + Math.sin(a) * r;
        if (!circleBlocked(this.map.geo, x, y, PLAYER_RADIUS + 4)) break search;
      }
    }
    p.x = x;
    p.y = y;
    this.meta.get(id)!.histFrom = this.tick + 1;
  }

  private queueInput(client: Client, msg: InputMessage) {
    const meta = this.meta.get(client.sessionId);
    if (!meta || !msg) return;
    const { seq, keys, angle, fire, slot } = msg;
    if (!Number.isInteger(seq) || seq <= meta.lastQueuedSeq) return;
    if (!Number.isInteger(keys) || (keys & ~KEY_MASK) !== 0) return;
    if (typeof angle !== "number" || !Number.isFinite(angle)) return;
    if (slot !== 0 && slot !== 1) return;
    if (meta.inputs.length >= MAX_QUEUED_INPUTS) return;
    meta.lastQueuedSeq = seq;
    meta.inputs.push({ seq, keys, angle, fire: fire === true, slot });
  }

  // ---- Simulation -------------------------------------------------------

  private get combat() {
    return this.state.phase === PHASE_DROP || this.state.phase === PHASE_PLAYING;
  }

  private update() {
    this.tick++;
    this.botWorld.tick = this.tick;
    this.botWorld.phase = this.state.phase;

    switch (this.state.phase) {
      case PHASE_LOBBY:
        if (this.countdown()) this.startDrop();
        break;
      case PHASE_DROP: {
        const plane = this.state.plane;
        plane.t = 1 - Math.max(0, this.phaseTicks - 1) / DROP_TICKS;
        const px = plane.x0 + (plane.x1 - plane.x0) * plane.t;
        const py = plane.y0 + (plane.y1 - plane.y0) * plane.t;
        this.state.players.forEach((p) => {
          if (!p.inPlane) return;
          p.x = px;
          p.y = py;
        });
        if (this.countdown()) this.startPlaying();
        break;
      }
      case PHASE_PLAYING:
        this.zone.update();
        this.setTimer(this.zone.secondsLeft);
        break;
      case PHASE_ENDED:
        if (this.countdown()) {
          this.enterLobby();
          return;
        }
        break;
    }

    const dps = this.state.phase === PHASE_PLAYING ? this.zone.dps : 0;
    const slot = this.tick % HISTORY_TICKS;
    this.state.players.forEach((player, id) => {
      if (!player.alive) return;
      const meta = this.meta.get(id)!;
      const bot = this.bots.get(id);
      if (bot) {
        this.applyInput(id, player, meta, bot.think(player, this.botWorld));
      } else {
        meta.inputCredit = Math.min(meta.inputCredit + 1, MAX_INPUT_CREDIT);
        for (let n = 0; n < MAX_INPUTS_PER_TICK && meta.inputCredit >= 1 && meta.inputs.length > 0; n++) {
          meta.inputCredit--;
          this.applyInput(id, player, meta, meta.inputs.shift()!);
        }
      }
      if (player.inPlane) return;

      meta.histX[slot] = player.x;
      meta.histY[slot] = player.y;

      if (!this.combat) return;
      this.finishTimers(player, meta);
      this.autoPickup(id, player);
      if (dps > 0 && this.zone.isOutside(player.x, player.y)) {
        meta.zoneDamage += dps * TICK_DT;
        if (meta.zoneDamage >= 1) {
          const amount = Math.floor(meta.zoneDamage);
          meta.zoneDamage -= amount;
          this.damage(id, amount, null, "zone");
        }
      }
    });

    this.updateBullets();

    let alive = 0;
    let last: string | null = null;
    this.state.players.forEach((p, id) => {
      if (p.alive) {
        alive++;
        last = id;
      }
    });
    this.setIfChanged("aliveCount", alive);
    this.setIfChanged("playerCount", this.combatants());
    if (this.combat && alive <= 1) this.endMatch(last);

    this.updateViews();
  }

  /** Tick the lobby/drop/results countdown; true when it runs out. */
  private countdown(): boolean {
    this.phaseTicks--;
    this.setTimer(Math.ceil(this.phaseTicks / TICK_RATE));
    return this.phaseTicks <= 0;
  }

  private applyInput(id: string, player: Player, meta: PlayerMeta, input: InputMessage) {
    const pressed = input.keys & ~meta.prevKeys;
    meta.prevKeys = input.keys;
    player.lastSeq = input.seq;
    player.angle = input.angle;

    if (player.inPlane) {
      if (pressed & KEY_JUMP) this.land(id, player);
      return;
    }

    const pos = this.scratch;
    pos.x = player.x;
    pos.y = player.y;
    stepPlayer(pos, input.keys, this.map.geo);
    // Positions go over the wire as float32; keep the server on the same values
    // so the client's replay from them matches the server bit for bit.
    player.x = Math.fround(pos.x);
    player.y = Math.fround(pos.y);

    if (!this.combat) return;

    // Humans: a slot switch is a change in the requested slot, so inputs sent
    // before the client saw a server-side switch (e.g. a pickup) can't undo it.
    // Bots have no latency, so theirs is simply the slot they want.
    const requested = this.bots.has(id) || input.slot !== meta.prevSlot;
    meta.prevSlot = input.slot;
    if (requested && input.slot !== player.slot && weaponIn(player, input.slot) !== WEAPON_NONE) {
      player.slot = input.slot;
      player.reloading = false;
    }
    if (pressed & KEY_INTERACT) this.pickupWeapon(id, player);
    if (pressed & KEY_RELOAD) this.startReload(player, meta);
    if (pressed & KEY_HEAL) this.startHeal(player, meta);
    if (input.fire) this.tryFire(id, player, meta);
  }

  // ---- Weapons ----------------------------------------------------------

  private tryFire(id: string, player: Player, meta: PlayerMeta) {
    if (this.tick < meta.nextFireTick || player.reloading) return;
    const type = activeWeapon(player);
    if (type === WEAPON_NONE) return;
    const mag = magIn(player, player.slot);
    if (mag === 0) {
      this.startReload(player, meta);
      return;
    }

    const weapon = WEAPONS[type];
    meta.nextFireTick = this.tick + weapon.cooldownTicks;
    player.healing = false; // shooting interrupts healing
    const rewind = this.bots.has(id)
      ? 0
      : Math.round(Math.min(LAG_COMP_MAX_MS, meta.latencyMs + INTERP_DELAY_MS) / TICK_MS);

    for (let i = 0; i < weapon.pellets; i++) {
      const angle = player.angle + (Math.random() * 2 - 1) * weapon.spread;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const x = player.x + dx * MUZZLE_OFFSET;
      const y = player.y + dy * MUZZLE_OFFSET;
      const bid = this.newId();
      const bullet = new Bullet();
      bullet.owner = id;
      bullet.x = x;
      bullet.y = y;
      bullet.angle = angle;
      bullet.weapon = type;
      this.state.bullets.set(bid, bullet);
      this.bullets.set(bid, { owner: id, weapon, x, y, dx, dy, traveled: 0, rewind });
    }

    setMag(player, player.slot, mag - 1);
    if (mag - 1 > 0) return;
    if (this.canReload(player, player.slot)) {
      this.startReload(player, meta);
    } else {
      // Out of ammo for good: throw it away and switch to whatever else we have.
      setSlotContents(player, player.slot, WEAPON_NONE, 0, 0);
      if (weaponIn(player, 1 - player.slot) !== WEAPON_NONE) player.slot = 1 - player.slot;
    }
  }

  private canReload(p: Player, slot: number): boolean {
    const type = weaponIn(p, slot);
    if (type === WEAPON_NONE) return false;
    const w = WEAPONS[type];
    return magIn(p, slot) < w.mag && (w.reserve === 0 || reserveIn(p, slot) > 0);
  }

  private startReload(p: Player, meta: PlayerMeta) {
    if (p.reloading || !this.canReload(p, p.slot)) return;
    p.reloading = true;
    meta.reloadDoneTick = this.tick + WEAPONS[activeWeapon(p)].reloadTicks;
  }

  private startHeal(p: Player, meta: PlayerMeta) {
    if (p.healing || p.medkits === 0 || p.hp >= MAX_HEALTH) return;
    p.healing = true;
    meta.healDoneTick = this.tick + MEDKIT_TICKS;
  }

  private finishTimers(p: Player, meta: PlayerMeta) {
    if (p.reloading && this.tick >= meta.reloadDoneTick) {
      p.reloading = false;
      const w = WEAPONS[activeWeapon(p)];
      const mag = magIn(p, p.slot);
      const take = w.reserve === 0 ? w.mag - mag : Math.min(w.mag - mag, reserveIn(p, p.slot));
      setMag(p, p.slot, mag + take);
      if (w.reserve > 0) setReserve(p, p.slot, reserveIn(p, p.slot) - take);
    }
    if (p.healing && this.tick >= meta.healDoneTick) {
      p.healing = false;
      p.hp = Math.min(MAX_HEALTH, p.hp + MEDKIT_HEAL);
      p.medkits--;
    }
  }

  private updateBullets() {
    const hitR = PLAYER_RADIUS + BULLET_RADIUS;

    for (const [id, b] of this.bullets) {
      const step = b.weapon.speed * TICK_DT;
      const x1 = b.x + b.dx * step;
      const y1 = b.y + b.dy * step;

      // Closest thing hit this step: something solid, or a player (rewound).
      const solid = raycastSolid(this.map.geo, b.x, b.y, x1, y1, BULLET_RADIUS);
      let hitT = solid ? solid.t : 2;
      let hitPlayer: string | null = null;
      const slot = (((this.tick - b.rewind) % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
      this.state.players.forEach((p, sid) => {
        if (!p.alive || p.inPlane || sid === b.owner) return;
        const meta = this.meta.get(sid)!;
        const rewound = this.tick - b.rewind >= meta.histFrom;
        const px = rewound ? meta.histX[slot] : p.x;
        const py = rewound ? meta.histY[slot] : p.y;
        const t = segmentCircleHit(b.x, b.y, x1, y1, px, py, hitR);
        if (t >= 0 && t < hitT) {
          hitT = t;
          hitPlayer = sid;
        }
      });

      b.traveled += step;
      if (hitT <= 1 || b.traveled >= b.weapon.range) {
        if (hitPlayer) this.damage(hitPlayer, b.weapon.damage, b.owner, b.weapon.name);
        else if (solid?.crateId && hitT === solid.t) this.damageCrate(solid.crateId, b.weapon.damage, b.owner);
        this.bullets.delete(id);
        this.state.bullets.delete(id);
      } else {
        b.x = x1;
        b.y = y1;
      }
    }
  }

  private damageCrate(id: string, amount: number, by?: string) {
    const crate = this.state.crates.get(id);
    if (!crate || !this.combat) return;
    if (crate.hp > amount) {
      crate.hp -= amount;
      return;
    }
    this.state.crates.delete(id);
    const i = this.map.crates.findIndex((c) => c.id === id);
    if (i >= 0) this.map.crates.splice(i, 1);
    const meta = by ? this.meta.get(by) : undefined;
    if (meta) meta.crates++;
    if (Math.random() < 0.6) {
      dropLoot(this.state, this.newId(), randomLootType(), crate.x + CRATE_SIZE / 2, crate.y + CRATE_SIZE / 2);
    }
  }

  private damage(victimId: string, amount: number, attackerId: string | null, cause: string) {
    if (!this.combat) return;
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive || victim.inPlane) return;

    if (attackerId && victim.armor > 0) {
      const absorbed = Math.min(victim.armor, Math.round(amount * ARMOR_ABSORB));
      victim.armor -= absorbed;
      amount -= absorbed;
    }
    const dealt = Math.min(victim.hp, Math.round(amount));
    victim.hp -= dealt;

    if (attackerId) {
      const attackerMeta = this.meta.get(attackerId);
      if (attackerMeta) attackerMeta.damageDealt += dealt;
      this.clients.getById(attackerId)?.send(MSG_HIT, {
        x: Math.round(victim.x), y: Math.round(victim.y), damage: dealt, kill: victim.hp === 0,
      } satisfies HitMessage);
    }
    if (victim.hp > 0) {
      const shooter = attackerId ? this.state.players.get(attackerId) : undefined;
      if (shooter) this.bots.get(victimId)?.onHurt(victim, attackerId!, shooter.x, shooter.y, this.map.geo, this.tick);
      return;
    }

    victim.alive = false;
    victim.healing = false;
    victim.reloading = false;
    let place = 1;
    this.state.players.forEach((p) => {
      if (p.alive) place++;
    });
    const attacker = attackerId ? this.state.players.get(attackerId) : undefined;
    if (attacker) attacker.kills++;

    // Spill their gear.
    let spill = 0;
    const scatter = () => {
      const a = spill++ * 2.1;
      return [victim.x + Math.cos(a) * 18, victim.y + Math.sin(a) * 18] as const;
    };
    for (const slot of [0, 1]) {
      const w = weaponIn(victim, slot);
      if (w !== WEAPON_NONE && w !== WEAPON_PISTOL) {
        dropLoot(this.state, this.newId(), w, ...scatter(), reserveIn(victim, slot) + magIn(victim, slot));
      }
    }
    for (let i = 0; i < victim.medkits; i++) dropLoot(this.state, this.newId(), LOOT_MEDKIT, ...scatter());

    this.broadcast(MSG_KILL, { killer: attacker?.name ?? "", victim: victim.name, weapon: cause } satisfies KillMessage);
    this.sendStats(victimId, victim, place, attacker?.name ?? "");
    const meta = this.meta.get(victimId)!;
    meta.watchId = attacker?.alive && attackerId ? attackerId : "";
    if (!meta.watchId) this.spectateNext(victimId);
    else this.sendSpectate(victimId);
  }

  /** A player's match is over: tell them how it went, and record it. */
  private sendStats(id: string, p: Player, place: number, killer: string) {
    const meta = this.meta.get(id);
    if (!meta) return;
    const client = this.clients.getById(id);
    const result: MatchResult = {
      place,
      kills: p.kills,
      damage: meta.damageDealt,
      survivedSeconds: Math.round((this.tick - meta.spawnTick) / TICK_RATE),
      items: Object.fromEntries(meta.collected),
      crates: meta.crates,
    };
    if (meta.profileId) {
      for (const a of profiles.record(meta.profileId, result)) {
        client?.send(MSG_NOTICE, `Achievement unlocked: ${a.title}`);
      }
    }
    if (!p.spectator) {
      // Collected here rather than at match end so leavers keep their record.
      this.matchLog.push({
        name: p.name, bot: p.bot, ...(meta.address ? { address: meta.address } : {}),
        place, kills: p.kills, damage: Math.round(meta.damageDealt),
        survivedSeconds: result.survivedSeconds, items: result.items, crates: result.crates,
      });
      if (meta.address) {
        this.matchEntries.push({
          ...result, address: meta.address, name: p.name, mapId: this.map.id, mapSeed: this.map.seed, matchId: this.matchId,
        });
      }
    }
    client?.send(MSG_STATS, {
      place,
      kills: p.kills,
      damage: meta.damageDealt,
      survivedSeconds: result.survivedSeconds,
      killer,
    } satisfies StatsMessage);
  }

  // ---- Loot -------------------------------------------------------------

  private autoPickup(id: string, player: Player) {
    const meta = this.meta.get(id)!;
    const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
    this.state.loot.forEach((loot, lootId) => {
      if ((loot.x - player.x) ** 2 + (loot.y - player.y) ** 2 > r2) return;
      if (loot.type === LOOT_MEDKIT && player.medkits < MAX_MEDKITS) {
        player.medkits++;
      } else if (loot.type === LOOT_ARMOR && player.armor < MAX_ARMOR) {
        player.armor = MAX_ARMOR;
      } else if (loot.type === LOOT_AMMO) {
        const slot = ammoTarget(player);
        if (slot < 0) return;
        const type = weaponIn(player, slot);
        const reserve = reserveIn(player, slot);
        if (reserve >= maxReserve(type)) return;
        setReserve(player, slot, Math.min(maxReserve(type), reserve + ammoPickupAmount(type)));
      } else {
        return;
      }
      meta.collected.set(loot.type, (meta.collected.get(loot.type) ?? 0) + 1);
      this.state.loot.delete(lootId);
    });
  }

  private pickupWeapon(id: string, player: Player) {
    let bestId: string | null = null;
    let bestD = PICKUP_RADIUS * PICKUP_RADIUS;
    this.state.loot.forEach((loot, lootId) => {
      if (!isWeaponLoot(loot.type)) return;
      const d = (loot.x - player.x) ** 2 + (loot.y - player.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        bestId = lootId;
      }
    });
    if (!bestId) return;
    const loot = this.state.loot.get(bestId)!;
    this.state.loot.delete(bestId);
    player.reloading = false;
    const meta = this.meta.get(id);
    if (meta) meta.collected.set(loot.type, (meta.collected.get(loot.type) ?? 0) + 1);
    const dropped = giveWeapon(player, loot.type, loot.amount);
    if (dropped) dropLoot(this.state, this.newId(), dropped.weapon, player.x, player.y, dropped.reserve);
  }

  // ---- Vision and spectating --------------------------------------------

  /**
   * Each client is only sent the players it can see: itself, whoever it's
   * spectating, and anyone canSee() allows from where it (or its spectate
   * target) stands. This is both anti-wallhack and interest management.
   */
  private updateViews() {
    const players = this.state.players;
    for (const client of this.clients) {
      const id = client.sessionId;
      const meta = this.meta.get(id);
      const self = players.get(id);
      const view = client.view;
      if (!meta || !self || !view) continue;

      const watching = !self.alive && (self.spectator || this.state.phase !== PHASE_LOBBY);
      if (watching && !players.get(meta.watchId)?.alive) {
        this.spectateNext(id);
      }
      const viewerId = self.alive ? id : meta.watchId || id;
      const viewer = players.get(viewerId) ?? self;

      const next = new Set<string>();
      players.forEach((p, pid) => {
        if (pid === id || pid === viewerId
            || (!p.inPlane && !viewer.inPlane && canSee(this.map.geo, viewer.x, viewer.y, p.x, p.y))) {
          next.add(pid);
        }
      });
      for (const pid of next) {
        if (!meta.visible.has(pid)) view.add(players.get(pid)!);
      }
      for (const pid of meta.visible) {
        if (next.has(pid)) continue;
        const p = players.get(pid);
        if (p) view.remove(p);
      }
      meta.visible = next;
    }
  }

  /** Point a dead player's camera at the next living player (in id order). */
  private spectateNext(id: string) {
    const meta = this.meta.get(id);
    const self = this.state.players.get(id);
    if (!meta || !self || self.alive) return;
    const ids: string[] = [];
    this.state.players.forEach((p, pid) => {
      if (p.alive && !p.inPlane && pid !== id) ids.push(pid);
    });
    ids.sort();
    const next = ids.find((pid) => pid > meta.watchId) ?? ids[0] ?? "";
    if (next === meta.watchId) return;
    meta.watchId = next;
    this.sendSpectate(id);
  }

  private sendSpectate(id: string) {
    const meta = this.meta.get(id);
    if (!meta) return;
    const target = this.state.players.get(meta.watchId);
    this.clients.getById(id)?.send(MSG_SPECTATE, { id: meta.watchId, name: target?.name ?? "" } satisfies SpectateMessage);
  }

  // ---- Helpers ----------------------------------------------------------

  private clearBullets() {
    this.bullets.clear();
    this.state.bullets.clear();
  }

  private setTimer(seconds: number) {
    this.setIfChanged("timer", seconds);
  }

  private setIfChanged(key: "timer" | "aliveCount" | "playerCount", value: number) {
    if (this.state[key] !== value) this.state[key] = value;
  }

  private newId() {
    return (this.nextId++).toString(36);
  }
}

function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 16);
}
