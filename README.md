# Battle Royale

A browser-based multiplayer top-down battle royale. TypeScript everywhere: [Phaser 4](https://phaser.io) on the client, [Colyseus 0.18](https://colyseus.io) on the server. Bots fill every room, so you can play alone. It works on desktop and on phones and tablets.

## Run it

Requires Node 22+.

```bash
npm install
npm run dev
```

Open http://localhost:5173, pick a bot difficulty, and press Play.

| Command | What it does |
|---|---|
| `npm run dev` | Game server on :2567 (restarts on save) and Vite client on :5173 (hot reload) |
| `npm test` | Unit tests (movement, collision, vision, inventory) and headless full-match tests, about 45 s |
| `npx vitest run shared` | Just the fast unit tests |
| `npm run typecheck` | Type-check server, client and shared code |
| `npm run build` | Build the client into `client/dist` |
| `npm start` | Production server: game server and built client on one port (`PORT`, default 2567) |

### Controls

| | Desktop | Touch |
|---|---|---|
| Move | WASD / arrows | Left stick |
| Aim / shoot | Mouse / click | Right stick (push far to shoot) |
| Switch weapon | 1, 2, Q or mouse wheel | Swap |
| Reload / heal / pick up | R / H / E | Buttons |
| Jump from the plane | Space or click | Jump |
| Next spectate target | Click or Space | Tap |

### Server environment variables

| Variable | Default | Effect |
|---|---|---|
| `BOT_FILL` | `10` | Bots top each room up to this many players (counting humans). `0` turns bots off |
| `LOBBY_SECONDS` | `15` | Countdown before the plane takes off |
| `DROP_SECONDS` | `18` | How long the plane flies (everyone still aboard is dropped at the end) |
| `MATCH_SPEED` | `1` | Speeds up the zone. `6` gives a match of about 40 seconds |
| `OBSTACLE_COUNT` / `BUILDING_COUNT` / `POND_COUNT` / `BUSH_COUNT` / `CRATE_COUNT` | `110` / `10` / `6` / `45` / `35` | Map generation |
| `LOOT_COUNT` | `90` | Loot outside buildings (each building also gets 2–4) |

For example, `BOT_FILL=20 LOBBY_SECONDS=5 MATCH_SPEED=4 npm run dev`.

## Deploy

```bash
docker build -t battle-royale .
docker run -p 2567:2567 battle-royale
```

One container (about 375 MB) serves the game page and the game server on port 2567. Put it behind a proxy that supports WebSockets for HTTPS. GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the typecheck, tests and build, and builds the Docker image, on every push.

## The game

- **Match flow:** a lobby (walk around, no shooting), then the **drop**, the match itself, and results, then back to the lobby. During the drop a plane crosses the map and you jump whenever you like (or get dropped at the end of its path). Rooms lock once the plane leaves, and there are no respawns.
- **Zone:** appears once the drop is over, then shrinks in 5 stages. Being outside costs 2 → 15 HP per second, and armor doesn't help.
- **Inventory:** two weapon slots, each with its own magazine and spare ammo. You start with a pistol (unlimited spare ammo). Picking up a weapon fills an empty slot, else replaces the pistol, else replaces the weapon in your hands (which drops). Reloading takes time, and a weapon with no ammo left is discarded. Medkits (up to 3) heal 50 HP over 2.5 s, and shooting cancels the heal. Armor soaks up half of weapon damage until it's used up. Ammo pickups go to a weapon that uses ammo.
- **Weapons:** pistol, SMG, shotgun (7 pellets) and rifle (long range, hits hard). Stats are in [shared/src/weapons.ts](shared/src/weapons.ts).
- **Terrain:** rocks and crates block bullets (crates break, and often drop loot); walls block bullets and sight; water slows you down; bushes hide you from anyone not right next to you; buildings have roofs that hide whoever is inside from people outside.
- **Feedback:** a crosshair, hit markers and floating damage numbers when your shots land, muzzle flashes, a camera shake when you're hit, death bursts, a landing effect, and synthesized sound.
- **After you're eliminated:** you see your place, kills, damage and survival time. You can spectate (switching between living players) or hit "Play again". The end of a match shows the winner and a kill leaderboard. Lifetime stats are kept in your browser and shown on the menu.
- **Reconnection:** if your connection drops, you have 20 seconds to get back into the same match. The client retries automatically, and refreshing the page rejoins too.

## Layout

```
shared/   Code both sides run: constants, weapons, inventory rules, wire protocol, state schema,
          movement/collision/vision (sim.ts), and unit tests
server/   GameRoom (match flow, simulation, per-client visibility), ZoneController, map generation,
          Bot AI, server entry (app.ts/index.ts), and network integration tests
client/   Phaser scene (prediction, interpolation, rendering, effects), HTML HUD, minimap,
          touch controls, synthesized sound, lifetime stats
```

## How the netcode works

- **Server-authoritative.** Clients send only inputs (`{seq, keys, angle, fire, slot}`) once per 30 Hz tick. The server validates them, applies at most 2 per player per tick, simulates, and broadcasts delta-compressed state at 30 Hz. Action keys (pick up, reload, heal, jump) and slot switches count only when they change, so inputs already in flight can't undo something the server just did (such as switching you to a weapon you picked up).
- **Visibility and interest management.** Each client only receives the players it can see (`canSee()` in [shared/src/sim.ts](shared/src/sim.ts): within range, not behind a wall, not under a roof you're outside of, not in a bush you're not next to). This uses Colyseus `StateView`s, so wall-hacking is impossible and bandwidth stays flat as lobbies grow. Bots use the same rule. Dead players see from their spectate target's position.
- **Client-side prediction.** The client applies its own movement straight away with the same `stepPlayer()` the server uses (including water and crates). When state arrives, it rewinds to the server position, drops the inputs the server has already applied, and replays the rest.
- **Interpolation.** Other players are drawn 100 ms in the past, between two buffered snapshots.
- **Lag compensation.** The server keeps about 300 ms of position history. A human's bullets are tested against where targets were on that player's screen: their ping plus the interpolation delay, capped at 300 ms.
- **Cheap bullets.** A bullet is synced once, when it spawns. Clients simulate its flight locally (with pooled objects) and stop it at the first solid hit.

## Bots

Bots ([server/src/Bot.ts](server/src/Bot.ts)) are ordinary players without a connection. Each tick their brain produces the same input message a human client sends, so they follow exactly the same rules.

- **Difficulty** (chosen on the menu; each difficulty gets its own rooms) sets aim error, reaction time, how well they lead moving targets, and how far they look.
- **Personalities** are assigned at random. *Aggressive* bots close in and chase. *Campers* settle in a building or bush inside the zone and wait. *Looters* grab everything useful and back off early. *Balanced* is in between.
- **Every bot** picks the right weapon slot for the distance, reloads and heals when it's safe, jumps from the plane at a random point, heads back inside the zone before it closes, and steers around obstacles.

Bots carry a `[bot]` tag. Every player gets their own color (unique until there are more than 20 players), and you're marked with a white ring.

## Known limitations

- Bots steer locally rather than planning a path, so they can get briefly stuck in building corners (they detect it and pick a new destination).
- Automatic reconnection only kicks in once a connection has been up for 5 seconds (an SDK rule). A drop in the first few seconds of joining sends you back to the menu.
- Map generation is random per room. There's no seeding or hand-made map yet.
