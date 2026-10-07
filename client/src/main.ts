import Phaser from "phaser";
import { Client, type Room } from "@colyseus/sdk";
import {
  DIFFICULTIES, type Difficulty, ERR_SERVER_FULL, GameState, type JoinOptions, LEADERBOARD_PATH, type LeaderboardEntry, MSG_SETTINGS,
  PHASE_DROP, PHASE_LOBBY, PHASE_PLAYING, type SettingsMessage,
} from "@br/shared";
import { Sfx } from "./audio";
import { describeCareer, loadCareer } from "./career";
import { GameScene } from "./GameScene";
import { Hud } from "./hud";
import { TouchControls, isTouchDevice } from "./touch";

// In dev the Vite server and the game server run on different ports. In
// production the game server serves this page, so it's the same origin.
const serverUrl: string = import.meta.env.VITE_SERVER_URL
  ?? (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2567` : location.origin);

/** Web storage that tolerates being unavailable (private mode, blocked site data). */
const storage = {
  get(store: Storage, key: string): string {
    try {
      return store.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(store: Storage, key: string, value: string) {
    try {
      if (value) store.setItem(key, value);
      else store.removeItem(key);
    } catch {
      // The value just won't persist.
    }
  },
};

/** Lets a page refresh rejoin the same match (the server holds the seat briefly). */
const RECONNECT_KEY = "reconnect";

const menu = document.getElementById("menu") as HTMLFormElement;
const nameInput = document.getElementById("name") as HTMLInputElement;
const difficultyInput = document.getElementById("difficulty") as HTMLSelectElement;
const career = document.getElementById("career")!;
const menuError = document.getElementById("menu-error")!;
const playButton = menu.querySelector("button")!;
const spectateButton = document.getElementById("spectate-button") as HTMLButtonElement;
const board = document.getElementById("board")!;
const boardRows = document.getElementById("board-rows")!;
const boardStatus = document.getElementById("board-status")!;
const pause = document.getElementById("pause") as HTMLFormElement;
const pauseName = document.getElementById("pause-name") as HTMLInputElement;
const pauseDifficulty = document.getElementById("pause-difficulty") as HTMLSelectElement;
const pauseNote = document.getElementById("pause-note")!;
const pauseSpectate = document.getElementById("pause-spectate") as HTMLInputElement;
const pauseSpectateNote = document.getElementById("pause-spectate-note")!;

const client = new Client(serverUrl);
const sfx = new Sfx();
const hud = new Hud(() => void playAgain());
const touch = isTouchDevice() ? new TouchControls(() => scene?.swapWeapon()) : null;
let game: Phaser.Game | null = null;
let scene: GameScene | null = null;
let room: Room<any, GameState> | null = null;
/** Joining (and rejoining) as a spectator. */
let spectating = false;

nameInput.value = storage.get(localStorage, "name");
const savedDifficulty = storage.get(localStorage, "difficulty");
if ((DIFFICULTIES as readonly string[]).includes(savedDifficulty)) difficultyInput.value = savedDifficulty;
career.textContent = describeCareer(loadCareer());

// The in-game menu: Esc (or the touch menu button) toggles it, and closing it applies the changes.
let pauseOpened = { name: "", difficulty: "", spectate: false };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !board.hidden) {
    board.hidden = true;
    return;
  }
  if (e.key !== "Escape" || !room) return;
  e.preventDefault();
  if (pause.hidden) openPause();
  else closePause();
});
document.getElementById("menu-button")!.addEventListener("click", () => openPause());
pause.addEventListener("submit", (e) => {
  e.preventDefault();
  closePause();
});

document.getElementById("board-button")!.addEventListener("click", () => void showBoard());
// From the Esc menu too; closing the board goes back to that menu.
document.getElementById("pause-board")!.addEventListener("click", () => void showBoard());
document.getElementById("board-close")!.addEventListener("click", () => (board.hidden = true));

/** The server's leaderboard of human players, from the start menu or the Esc menu. */
async function showBoard() {
  board.hidden = false;
  boardRows.replaceChildren();
  boardStatus.textContent = "Loading…";
  let list: LeaderboardEntry[];
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}${LEADERBOARD_PATH}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
  } catch (err) {
    console.error(err);
    boardStatus.textContent = "Could not load the leaderboard.";
    return;
  }
  boardStatus.textContent = list.length ? "" : "No results yet. Finish a match with a name to get on the board.";
  // In a game, our name may have changed since the start menu.
  const me = (room?.state.players.get(room.sessionId)?.name ?? nameInput.value).trim().toLowerCase();
  boardRows.replaceChildren(...list.map((e, i) => {
    const row = document.createElement("tr");
    row.classList.toggle("me", !!me && e.name.toLowerCase() === me);
    for (const [value, cls] of [[i + 1], [e.name, "name"], [e.wins], [e.kills], [e.matches], [`#${e.bestPlace}`]] as const) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      if (cls) cell.className = cls;
      row.append(cell);
    }
    return row;
  }));
}

function openPause() {
  if (!room || !scene || !pause.hidden) return;
  const me = room.state.players.get(room.sessionId);
  const phase = room.state.phase;
  pauseOpened = {
    name: me?.name ?? nameInput.value.trim(),
    difficulty: room.state.difficulty,
    spectate: me?.spectator ?? false,
  };
  pauseName.value = pauseOpened.name;
  pauseDifficulty.value = pauseOpened.difficulty;
  pauseNote.textContent = phase === PHASE_LOBBY
    ? "Bots change for everyone in this game."
    : "Bots change for everyone in this game, from the next match.";
  // The server refuses to let a living player bow out mid-match.
  const fighting = !!me?.alive && (phase === PHASE_DROP || phase === PHASE_PLAYING);
  pauseSpectate.checked = pauseOpened.spectate;
  pauseSpectate.disabled = fighting;
  pauseSpectateNote.textContent = fighting
    ? "You can switch to spectating once you're out of this match."
    : pauseOpened.spectate && phase !== PHASE_LOBBY ? "Untick to play from the next match." : "";
  scene.setPaused(true);
  pause.hidden = false;
}

function closePause() {
  if (pause.hidden) return;
  pause.hidden = true;
  scene?.setPaused(false);
  // Send only what changed, so we don't undo someone else's change made meanwhile.
  const msg: SettingsMessage = {};
  const name = pauseName.value.trim();
  if (name && name !== pauseOpened.name) {
    msg.name = name;
    nameInput.value = name;
    storage.set(localStorage, "name", name);
  }
  const difficulty = pauseDifficulty.value as Difficulty;
  if (difficulty !== pauseOpened.difficulty) {
    msg.difficulty = difficulty;
    // Also the default for games we start from now on.
    difficultyInput.value = difficulty;
    storage.set(localStorage, "difficulty", difficulty);
  }
  if (!pauseSpectate.disabled && pauseSpectate.checked !== pauseOpened.spectate) {
    msg.spectate = pauseSpectate.checked;
    spectating = msg.spectate;
  }
  if (msg.name || msg.difficulty || msg.spectate !== undefined) room?.send(MSG_SETTINGS, msg);
}

menu.addEventListener("submit", (e) => {
  e.preventDefault();
  void enter(false);
});
spectateButton.addEventListener("click", () => void enter(true));

/** From the start menu: play, or just watch. */
async function enter(spectate: boolean) {
  sfx.unlock();
  playButton.disabled = spectateButton.disabled = true;
  menuError.textContent = "";
  storage.set(localStorage, "name", nameInput.value.trim());
  storage.set(localStorage, "difficulty", difficultyInput.value);
  spectating = spectate;
  try {
    await start(() => joinNew());
  } catch (err) {
    showMenu(err);
  }
}

// Back from a refresh mid-match? Try to slip back into the same seat.
const token = storage.get(sessionStorage, RECONNECT_KEY);
if (token) {
  menu.style.display = "none";
  start(() => client.reconnect(token, GameState)).catch(() => {
    storage.set(sessionStorage, RECONNECT_KEY, "");
    showMenu(null);
  });
} else {
  nameInput.focus();
}

/** Join the busiest room for this difficulty, or with `fresh`, start a room of our own. */
async function joinNew(fresh = false) {
  const options: JoinOptions = {
    name: nameInput.value.trim(), difficulty: difficultyInput.value as Difficulty, spectate: spectating,
  };
  const join = () => client.joinOrCreate("battle", options, GameState);
  if (!fresh) return join();
  // No room for another game: join one in progress instead (spectating it until the next lobby).
  return client.create("battle", options, GameState).catch((err: { code?: number }) => {
    if (err?.code === ERR_SERVER_FULL) return join();
    throw err;
  });
}

async function start(join: () => Promise<Room<any, GameState>>) {
  const joined = await join();
  room = joined;
  storage.set(sessionStorage, RECONNECT_KEY, joined.reconnectionToken);
  joined.onReconnect(() => storage.set(sessionStorage, RECONNECT_KEY, joined.reconnectionToken));
  joined.onLeave(() => {
    if (room === joined) storage.set(sessionStorage, RECONNECT_KEY, "");
  });

  menu.style.display = "none";
  document.body.classList.add("playing");
  hud.reset();
  hud.show();
  const next = new GameScene(joined, hud, sfx, touch);
  scene = next;
  // Debug handle for the browser console.
  if (import.meta.env.DEV) Object.assign(window, { __scene: next });
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#1d2b1f",
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: next,
  });
}

/**
 * Leave this room and join again. Rooms stay open mid-match, so rejoining one
 * whose match is still running would only spectate it: start a fresh room then.
 */
async function playAgain() {
  const old = room;
  const phase = old?.state.phase;
  const fresh = phase === PHASE_DROP || phase === PHASE_PLAYING;
  pause.hidden = true;
  scene?.dispose();
  game?.destroy(true);
  game = null;
  scene = null;
  room = null;
  storage.set(sessionStorage, RECONNECT_KEY, "");
  await old?.leave().catch(() => {});
  try {
    await start(() => joinNew(fresh));
  } catch (err) {
    showMenu(err);
  }
}

function showMenu(err: unknown) {
  if (err) console.error(err);
  document.body.classList.remove("playing");
  pause.hidden = true;
  menu.style.display = "";
  menuError.textContent = err ? `Could not join: ${err instanceof Error ? err.message : err}` : "";
  career.textContent = describeCareer(loadCareer());
  playButton.disabled = spectateButton.disabled = false;
}
