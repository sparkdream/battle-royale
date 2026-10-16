# Battle Royale

A browser-based multiplayer top-down battle royale. TypeScript everywhere: [Phaser 4](https://phaser.io) on the client, [Colyseus 0.18](https://colyseus.io) on the server. Bots fill every room, so you can play alone. It works on desktop and on phones and tablets.

## Run it

Requires Node 22+.

```bash
npm install
npm run dev
```

Open http://localhost:5173, pick a bot difficulty, and press Play.

Other machines on your LAN can join at `http://<this machine's IP>:5173` (Vite prints the "Network" URL). The client connects to port 2567 on the same host, so the firewall must allow inbound TCP 5173 and 2567 (with `npm start`, only the one `PORT`). Under WSL2 this needs `networkingMode=mirrored` in `.wslconfig` plus a Hyper-V firewall rule, from an admin PowerShell:

```powershell
New-NetFirewallHyperVRule -Name BattleRoyaleDev -DisplayName "Battle royale dev" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 5173,2567
```

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
| Menu (name, bot difficulty, spectate, leaderboard) | Esc | ☰ button |
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
| `MAX_ROOMS` | `10` | Most games running at once. Past it, new games are refused ("server is full") and players join an existing one |
| `DB_FILE` | `data/game.db` | SQLite file with guest profiles, the leaderboard, achievements and funnel counts. Empty: memory only |
| `ADMIN_TOKEN` | unset | Turns on `GET /admin/funnel` (funnel counts as JSON), which then needs `Authorization: Bearer <ADMIN_TOKEN>` |
| `CHAIN_ENABLED` | `0` | `1` turns on onchain recording (needs `CHAIN_MNEMONIC`, or `CHAIN_SESSION_KEY_FILE` + `CHAIN_GRANTER`) |
| `CHAIN_MNEMONIC` | — | Key mode: the relayer account's mnemonic. A funded, x/rep-membered key that signs every game tx and creates the classes |
| `CHAIN_SESSION_KEY_FILE` / `CHAIN_GRANTER` | — | Session mode (instead of a mnemonic): a file holding an x/session key's mnemonic, and the game management account that granted it. The game signs `MsgMint` and `MsgUpdateToken` through `MsgExecSession`, re-reading the file before every tx; the granter must have created the classes itself |
| `CHAIN_RPC` / `CHAIN_LCD` | sparkdream devnet | Endpoints of the chain to write to |
| `CHAIN_ID` / `CHAIN_DENOM` / `CHAIN_PREFIX` | `sparkdream-dev-1` / `usparz.sparkdreamdev` / `sprkdrm` | Chain identity |
| `CHAIN_NAME` / `CHAIN_DISPLAY_DENOM` | `Spark Dream Devnet` / `SPARK` | How Keplr shows the chain and its coin when the game suggests it |
| `CHAIN_GAS_PRICE` | `0.025usparz.sparkdreamdev` | Gas price for relayer txs |
| `CHAIN_EXPLORER` | `https://explorer-devnet.sparkdream.io/sparkdream` | Where tx links point. Empty: no links |
| `CHAIN_MEMO` | `battle-royale` | Memo on the game's txs, so they're recognisable in explorers |
| `PUBLIC_URL` | unset | This server's public origin (e.g. `https://battle.sparkdream.io`), the base of match token uris. Unset: uris are bare `/matches/<id>` paths |

For example, `BOT_FILL=20 LOBBY_SECONDS=5 MATCH_SPEED=4 npm run dev`.

## Web3: Spark Dream chain

Optional, off by default. When enabled, players can connect Keplr and get
their results recorded on a Spark Dream chain through its **x/artifact**
module — no game-specific chain code:

- **Identity.** "Connect Keplr" in the menu signs a server nonce
  (`/auth/nonce` → `signArbitrary` → `/auth/verify`). The proof returns a
  secret ticket that travels with every join, alongside the guest profile,
  so results are also recorded against the address (the address itself is
  public, so it is never the credential).
- **Career records.** One soulbound `BRCAREER` token per linked player,
  metadata updated after every match: matches, wins, kills, damage, best
  place, items collected (by type), crates broken, maps played, achievements.
  The token is the onchain leaderboard — `/leaderboard` reads the class and
  merges it with the profiles (onchain rows win name collisions, which also
  keeps a linked player from showing up twice).
- **Achievement badges.** The same achievements profiles earn
  ([shared/src/achievements.ts](shared/src/achievements.ts)), evaluated
  against the onchain career at match end; each unlock mints a soulbound
  `BRBADGE` token to the player, with the achievement's code as an attribute.
- **Map collectibles.** Map layouts are now generated from a seed
  (same seed → identical map; the map id is a hash of seed + counts). The
  winner of each match is minted a transferable `BRMAP` token carrying the
  seed, so the ground a victory happened on can be regenerated and verified.
- **Match records.** Every match with a linked player also mints one
  soulbound `BRMATCH` token to the relayer: a ledger entry, not a collectible.
  Its attributes are minimal (match id, map, seed, end time, player count,
  winner); its `uri` points at `GET /matches/<id>` on the game server, which
  serves the full result (every participant, bots included, with place,
  kills, damage, items and crates), and its `uriHash` is the sha256 of
  exactly those bytes. Career tokens carry `last_match`, so a career can be
  audited match by match. Records are kept in the profile database for every
  match with a human in it, chain or not. Each token costs the relayer the
  usual 0.1 SPARK deposit plus gas; at thousands of matches a day, switch to
  periodic checkpoint tokens (one per period holding a Merkle root).
- **Session keys.** On a host you don't control (Akash), don't give the
  server the account's mnemonic: have the game management account create the
  four classes itself (`MsgCreateClass` burns SPARK and is not delegable),
  then grant the server an x/session key scoped to `MsgMint` and
  `MsgUpdateToken` with a fee budget and an expiry, and point
  `CHAIN_SESSION_KEY_FILE` / `CHAIN_GRANTER` at it. The chain executes the
  game's writes as the granter and takes the fees from the grant; a stolen
  key can only mint into the game's classes until the grant is revoked. The
  Spark Dream launcher automates this (classes, grant, delivery, renewal).
  Needs a chain whose x/session allowlist includes the two artifact messages.
- **UX.** Server-relayer model: the game server signs all chain writes, so
  players get exactly one Keplr popup (the login signature), never per match.
  Everything degrades gracefully: no wallet → guest-profile play; chain
  down → results still count in the profile and the write is skipped. A
  chain that can't be reached at startup (or classes the granter hasn't
  created yet) is retried every 30 s, backing off to 10 minutes.

### Running it against the devnet

1. **Relayer account.** Generate a mnemonic (`sparkdreamd keys add br-relayer`),
   fund it with the fee denom (devnet faucet or an operator account; class
   creation burns 10 SPARK, each live token deposits 0.1 SPARK, gas is per
   tx), and have an existing member invite it so it becomes an **active
   x/rep member** — class creation requires trust level ≥ 1, and membership
   also makes it a *trusted sender* so badge/career mints land directly in
   players' wallets instead of their inboxes.
2. **Configure.**
   `CHAIN_ENABLED=1 CHAIN_MNEMONIC="… tvrq …" npm run dev`
   (all `CHAIN_*` variables listed above).
3. **Play.** The menu shows "Connect Keplr"; the server logs the relayer
   address and the resolved class ids on boot. The four classes are created
   automatically the first time.

`@sparkdreamnft/sparkdreamjs` is the only chain client: its signing client
signs the relayer's txs and its query client reads tokens back.

## Deploy

```bash
docker build -t battle-royale .
docker run -p 2567:2567 -v br-data:/app/data battle-royale
```

The volume keeps the profile database (and so the leaderboard) when the container is replaced.

All games run on one CPU core: a full game (50 players and bots) uses about 6% of a core and each client about 10 KB/s, so the default `MAX_ROOMS=10` (500 connections) leaves plenty of headroom on a small server. Raise it on a bigger machine.

One container (about 375 MB) serves the game page and the game server on port 2567. Put it behind a proxy that supports WebSockets for HTTPS. GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the typecheck, tests and build, and builds the Docker image, on every push.

### Deploy to Akash

The game runs on [Akash](https://akash.network) at https://battle.sparkdream.io, deployed with [deploy.yaml](deploy.yaml): 1 CPU, 1 GB of memory, and a 1 GB persistent volume for the profile database. Each release is a version `vX.Y.Z` used for the git tag, the image tag and `version` in `package.json`.

```bash
# Bump "version" in package.json and the image tag in deploy.yaml, commit, then:
git tag v1.0.0 && git push origin main v1.0.0

docker build -t sparkdreamnft/battle-royale:v1.0.0 .
docker push sparkdreamnft/battle-royale:v1.0.0

# Create the deployment (or paste deploy.yaml into Akash Console)
akash tx deployment create deploy.yaml --from <key> --chain-id akashnet-2 --node <akash-rpc>
```

The Spark Dream launcher can deploy it too: in a services fleet (or a chain fleet), **+ add component… → Battle royale**, with the domain. For web3 mode, give it the game management account: a member address whose key stays in your wallet (the launcher pauses for your signature to create the classes and to grant the session key, with CLI commands for a key on another computer), or `topology.components.battle.web3` in the spec editor with `account` (a launcher-generated member) and `target.fleet` (the chain fleet, when the game runs in a services fleet). The launcher renders every `CHAIN_*` variable and `PUBLIC_URL` from the fleet's spec and delivers the session key into the game's data volume; no key is in the deployment. It pins the image tag in its profiles (`BATTLE_IMAGE` in `packages/launch-spec/src/profiles.ts`); bump it there when you release.

To release a new version, push the new image and update the existing deployment with the new tag (Console: Update; CLI: `akash tx deployment update deploy.yaml ...`). An update keeps the lease and the profile database. Always use a new tag: providers cache images, so a reused tag may not update.

**HTTPS.** Akash providers serve plain HTTP on port 80. `battle.sparkdream.io` is a proxied Cloudflare CNAME to the lease's ingress hostname (`<id>.ingress.<provider>`), with SSL mode *Flexible*, like the other services. Cloudflare passes WebSockets through, and the client connects to the origin that served the page, so the image has no domain built in. Recreating the deployment (rather than updating it) gives a new ingress hostname: update the CNAME.

**Profile database.** It lives on the persistent volume, which survives restarts and updates but not closing the lease or moving to another provider. Copy `/app/data/game.db` out first (Console's shell, or `provider-services lease-shell`) if you want to keep it; with the server stopped, or copy `game.db-wal` too.

## The game

- **Match flow:** a lobby (walk around, no shooting), then the **drop**, the match itself, and results, then back to the lobby. During the drop a plane crosses the map and you jump whenever you like (or get dropped at the end of its path). There are no respawns. Players who join after the plane leaves spectate the match in progress and play from the next one; new players are matched into the room with the most humans, so friends on a LAN end up together.
- **Zone:** appears once the drop is over, then shrinks in 5 stages. Being outside costs 2 → 15 HP per second, and armor doesn't help.
- **Inventory:** two weapon slots, each with its own magazine and spare ammo. You start with a pistol (unlimited spare ammo). Picking up a weapon fills an empty slot, else replaces the pistol, else replaces the weapon in your hands (which drops). Reloading takes time, and a weapon with no ammo left is discarded. Medkits (up to 3) heal 50 HP over 2.5 s, and shooting cancels the heal. Armor soaks up half of weapon damage until it's used up. Ammo pickups go to a weapon that uses ammo.
- **Weapons:** pistol, SMG, shotgun (7 pellets) and rifle (long range, hits hard). Stats are in [shared/src/weapons.ts](shared/src/weapons.ts).
- **Terrain:** rocks and crates block bullets (crates break, and often drop loot); walls block bullets and sight; water slows you down; bushes hide you from anyone not right next to you; buildings have roofs that hide whoever is inside from people outside.
- **Feedback:** a crosshair, hit markers and floating damage numbers when your shots land, muzzle flashes, a camera shake when you're hit, death bursts, a landing effect, and synthesized sound.
- **After you're eliminated:** you see your place, kills, damage and survival time. You can spectate (switching between living players) or hit "Play again". The end of a match shows the winner and a kill leaderboard. Lifetime stats are kept in your browser and shown on the menu.
- **Spectating:** press Spectate on the start menu to only watch: you follow players (click or Space for the next one), the plane during the drop, and aren't counted as a player or take a bot's place. A spectator on their own still gets a bots-only match to watch. Switch between playing and spectating with "Just spectate" in the Esc menu (not while you're alive in a match).
- **Guest profiles:** on its first visit the browser makes a secret token (localStorage) and the server keeps a profile under it: no sign-up. A name belongs to the first profile that takes it (case-insensitive), so nobody can play under yours; asking for a taken name keeps your current one, with a notice. Clearing site data loses the profile.
- **Leaderboard:** every named profile's wins, kills, matches and best place, ranked by wins then kills. Open it from the start menu or the Esc menu. Bots and players who left the name blank aren't on it.
- **Achievements:** milestones (first match, first elimination, first win, 5 or 10 eliminations in a match, surviving 4 minutes, picking up every special weapon, 100 items, 25 crates, 100 eliminations, 25 matches, 10 wins; [shared/src/achievements.ts](shared/src/achievements.ts)) are recorded per profile with a notice when earned. With a linked wallet they're also minted as badges (see "Web3").
- **Funnel:** a `?ref=` in the URL on a browser's first visit is stored with its profile. `GET /admin/funnel` (needs `ADMIN_TOKEN`) reports profiles, players who finished a match, returning players (2+ days), 7-day actives, the same by ref, and humans per match.
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

- **Difficulty** (chosen on the start menu for a new game; anyone in a game can change it from the Esc menu, for everyone, from the next lobby) sets aim error, reaction time, how well they lead moving targets, how far they look, and how long they keep hunting someone who hid (3, 6 or 9 s).
- **Personalities** are assigned at random. *Aggressive* bots close in and chase. *Campers* settle in a building or bush inside the zone and wait. *Looters* grab everything useful and back off early. *Balanced* is in between.
- **Every bot** picks the right weapon slot for the distance, reloads and heals when it's safe, jumps from the plane at a random point, heads back inside the zone before it closes, and steers around obstacles.
- **Hiding doesn't shake them.** A target that ducks into a bush, under a roof or behind a wall is hunted where it vanished: bots keep firing bursts into the bush, chasers (*aggressive*, *balanced*) go in after it, and the others hold their ground covering the spot until they forget. A bot shot by someone it can't see turns on the shooter, guessing where the shots came from.

Bots carry a `[bot]` tag. Every player gets their own color (unique until there are more than 20 players), and you're marked with a white ring.

## Known limitations

- Bots steer locally rather than planning a path, so they can get briefly stuck in building corners (they detect it and pick a new destination).
- Automatic reconnection only kicks in once a connection has been up for 5 seconds (an SDK rule). A drop in the first few seconds of joining sends you back to the menu.
- Profiles live in one browser: there's no way yet to move one to another device or recover it after clearing site data.
- The old `data/leaderboard.json` isn't imported: results start over in `data/game.db`.
- Node prints an `ExperimentalWarning` for `node:sqlite` at startup; it's harmless.
- Map generation is seeded per room (the same seed reproduces a layout; winners get the seed onchain), but there are no hand-made maps yet.
- Lag compensation rewinds by the latency the client reports (capped at 300 ms), not one the server measures, so a client lying about its ping can hit slightly further into the past.
- Onchain match writes trust the game server (it signs everything). Forging results would require the relayer key. Match records are served by the same server; the onchain hash proves a record wasn't changed after the match, not that it was true.
- A match's chain writes go out in chunks of 8 messages (one tx each); if a later chunk fails, the earlier ones stay and nothing is retried. The match token goes first, so a career's `last_match` always exists; what can be missing is a badge or the map token.
- A profile and a wallet aren't linked to each other: a wallet's onchain career starts from its first linked match, and badges follow that career, not the profile's achievements.
