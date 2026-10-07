import type { KillMessage, MatchEndMessage, StatsMessage } from "@br/shared";

const FEED_MS = 5000;
const FEED_MAX = 5;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export interface SlotInfo {
  name: string;
  /** e.g. "12 / 90", "8 / ∞", or "" for an empty slot. */
  ammo: string;
  active: boolean;
  empty: boolean;
}

/** HTML overlay for everything that isn't the game world. Setters skip no-op DOM writes. */
export class Hud {
  readonly minimapCanvas = el<HTMLCanvasElement>("minimap");
  private root = el("hud");
  private hpFill = el("hp-fill");
  private armorFill = el("armor-fill");
  private alive = el("alive");
  private kills = el("kills");
  private ping = el("ping");
  private status = el("status");
  private prompt = el("prompt");
  private action = el("action");
  private actionLabel = el("action-label");
  private actionFill = el("action-fill");
  private slots = [el("slot0"), el("slot1")];
  private medkits = el("medkits");
  private feed = el("feed");
  private banner = el("banner");
  private bannerTitle = el("banner-title");
  private bannerSub = el("banner-sub");
  private bannerStats = el("banner-stats");
  private bannerBoard = el("banner-board");
  private bannerHint = el("banner-hint");
  private playAgain = el<HTMLButtonElement>("play-again");
  private cache = new Map<string, unknown>();

  constructor(onPlayAgain: () => void) {
    this.playAgain.onclick = () => {
      this.playAgain.disabled = true;
      onPlayAgain();
    };
  }

  show() {
    this.root.hidden = false;
  }

  reset() {
    this.cache.clear();
    this.feed.replaceChildren();
    this.hideBanner();
    this.setPrompt("");
    this.setAction("", 0);
    this.setStatus("", false);
    this.playAgain.disabled = false;
  }

  setHp(hp: number) {
    if (!this.changed("hp", hp)) return;
    this.hpFill.style.width = `${hp}%`;
    this.hpFill.style.background = hp > 50 ? "#6fcf6f" : hp > 25 ? "#f2c94c" : "#eb5757";
  }

  /** Spectators have no health or inventory to show. */
  setSpectator(on: boolean) {
    if (this.changed("spectator", on)) this.root.classList.toggle("spectator", on);
  }

  setArmor(armor: number) {
    if (this.changed("armor", armor)) this.armorFill.style.width = `${armor}%`;
  }

  setSlot(i: number, slot: SlotInfo) {
    const key = `slot${i}`;
    const sig = `${slot.name}|${slot.ammo}|${slot.active}|${slot.empty}`;
    if (!this.changed(key, sig)) return;
    const node = this.slots[i];
    node.querySelector(".name")!.textContent = slot.empty ? "Empty" : slot.name;
    node.querySelector(".ammo")!.textContent = slot.ammo;
    node.classList.toggle("active", slot.active);
    node.classList.toggle("empty", slot.empty);
  }

  setMedkits(n: number) {
    if (this.changed("medkits", n)) this.medkits.textContent = `×${n}`;
  }

  /** Reload/heal progress; empty label hides it. */
  setAction(label: string, progress: number) {
    if (this.changed("action", label)) {
      this.actionLabel.textContent = label;
      this.action.hidden = label === "";
    }
    this.actionFill.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
  }

  setStats(alive: number, kills: number) {
    if (this.changed("alive", alive)) this.alive.textContent = `${alive} alive`;
    if (this.changed("kills", kills)) this.kills.textContent = String(kills);
  }

  setPing(ms: number) {
    this.ping.textContent = `${Math.round(ms)} ms`;
  }

  setStatus(text: string, warn: boolean) {
    if (this.changed("status", text)) this.status.textContent = text;
    if (this.changed("warn", warn)) this.status.classList.toggle("warn", warn);
  }

  setPrompt(text: string) {
    if (!this.changed("prompt", text)) return;
    this.prompt.textContent = text;
    this.prompt.hidden = text === "";
  }

  /** A plain line in the feed, e.g. a settings change. */
  notice(text: string) {
    const row = document.createElement("div");
    row.textContent = text;
    this.pushFeed(row);
  }

  kill({ killer, victim, weapon }: KillMessage) {
    const row = document.createElement("div");
    if (killer) {
      row.append(`${killer} `);
      const w = document.createElement("span");
      w.className = "weapon";
      w.textContent = `[${weapon}]`;
      row.append(w, ` ${victim}`);
    } else {
      row.textContent = `${victim} was caught by the zone`;
    }
    this.pushFeed(row);
  }

  private pushFeed(row: HTMLElement) {
    this.feed.prepend(row);
    while (this.feed.childElementCount > FEED_MAX) this.feed.lastElementChild!.remove();
    setTimeout(() => row.remove(), FEED_MS);
  }

  showBanner(opts: {
    title: string;
    sub?: string;
    stats?: StatsMessage | null;
    leaderboard?: MatchEndMessage["leaderboard"];
    playAgain?: boolean;
    hint?: string;
  }) {
    this.bannerTitle.textContent = opts.title;
    this.bannerSub.textContent = opts.sub ?? "";
    this.bannerStats.replaceChildren();
    if (opts.stats) {
      const s = opts.stats;
      const cells: [string, string][] = [
        [`#${s.place}`, "place"],
        [String(s.kills), s.kills === 1 ? "kill" : "kills"],
        [String(s.damage), "damage"],
        [formatTime(s.survivedSeconds), "survived"],
      ];
      for (const [value, label] of cells) {
        const cell = document.createElement("div");
        cell.innerHTML = `<div class="value"></div><div class="label"></div>`;
        cell.querySelector(".value")!.textContent = value;
        cell.querySelector(".label")!.textContent = label;
        this.bannerStats.append(cell);
      }
    }
    this.bannerBoard.replaceChildren(...(opts.leaderboard ?? []).map(({ name, kills }) => {
      const li = document.createElement("li");
      li.textContent = name;
      const k = document.createElement("span");
      k.textContent = `${kills} ${kills === 1 ? "kill" : "kills"}`;
      li.append(k);
      return li;
    }));
    this.bannerHint.textContent = opts.hint ?? "";
    this.playAgain.hidden = !opts.playAgain;
    this.banner.hidden = false;
  }

  setBannerHint(text: string) {
    this.bannerHint.textContent = text;
  }

  hideBanner() {
    this.banner.hidden = true;
  }

  get bannerVisible() {
    return !this.banner.hidden;
  }

  private changed(key: string, value: unknown): boolean {
    if (this.cache.get(key) === value) return false;
    this.cache.set(key, value);
    return true;
  }
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
