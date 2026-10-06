import Phaser from "phaser";
import { Client, type Room } from "@colyseus/sdk";
import { DIFFICULTIES, type Difficulty, GameState, type JoinOptions } from "@br/shared";
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

const client = new Client(serverUrl);
const sfx = new Sfx();
const hud = new Hud(() => void playAgain());
const touch = isTouchDevice() ? new TouchControls(() => scene?.swapWeapon()) : null;
let game: Phaser.Game | null = null;
let scene: GameScene | null = null;
let room: Room<any, GameState> | null = null;

nameInput.value = storage.get(localStorage, "name");
const savedDifficulty = storage.get(localStorage, "difficulty");
if ((DIFFICULTIES as readonly string[]).includes(savedDifficulty)) difficultyInput.value = savedDifficulty;
career.textContent = describeCareer(loadCareer());

menu.addEventListener("submit", async (e) => {
  e.preventDefault();
  sfx.unlock();
  playButton.disabled = true;
  menuError.textContent = "";
  storage.set(localStorage, "name", nameInput.value.trim());
  storage.set(localStorage, "difficulty", difficultyInput.value);
  try {
    await start(joinNew);
  } catch (err) {
    showMenu(err);
  }
});

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

function joinNew() {
  const options: JoinOptions = { name: nameInput.value.trim(), difficulty: difficultyInput.value as Difficulty };
  return client.joinOrCreate("battle", options, GameState);
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

/** Leave this room (match still running) and queue for a fresh one. */
async function playAgain() {
  const old = room;
  scene?.dispose();
  game?.destroy(true);
  game = null;
  scene = null;
  room = null;
  storage.set(sessionStorage, RECONNECT_KEY, "");
  await old?.leave().catch(() => {});
  try {
    await start(joinNew);
  } catch (err) {
    showMenu(err);
  }
}

function showMenu(err: unknown) {
  if (err) console.error(err);
  document.body.classList.remove("playing");
  menu.style.display = "";
  menuError.textContent = err ? `Could not join: ${err instanceof Error ? err.message : err}` : "";
  career.textContent = describeCareer(loadCareer());
  playButton.disabled = false;
}
