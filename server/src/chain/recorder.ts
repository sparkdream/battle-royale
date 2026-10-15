/**
 * Turns finished matches into onchain writes: updates each linked player's
 * career token, mints newly earned achievement badges, mints the map
 * champion token to the winner, and mints one match token (held by the
 * relayer) anchoring the full result by hash. The chain is the source of truth for careers
 * (reloaded from tokens after a restart); failures evict the cache so the
 * next match re-reads reality.
 */

import type { EncodeObject } from "@cosmjs/proto-signing";
import {
  MATCH_RECORD_PATH, careerFromAttributes, careerToAttributes, emptyCareer, mergeCareer, newAchievements,
  type CareerStats, type LeaderboardEntry, type MatchEntry, type MatchRecord, type Web3Notice,
} from "@br/shared";
import { encodeMatchRecord } from "../matchRecord";
import type { ChainClient, ChainToken } from "./client";
import { CLASS_SPECS, createClassMsg, type ClassIds } from "./classes";

const MSG_MINT = "/sparkdream.artifact.v1.MsgMint";
const MSG_UPDATE_TOKEN = "/sparkdream.artifact.v1.MsgUpdateToken";

export interface LeaderboardRow extends LeaderboardEntry {
  address: string;
  onchain: true;
}

export type NoticeSink = (address: string, notice: Web3Notice) => boolean;

interface CareerRecord {
  stats: CareerStats;
  /** null until their career token has been minted (resolved lazily). */
  tokenId: string | null;
}

export class Web3Recorder {
  private careers = new Map<string, CareerRecord>();
  private sinks = new Set<NoticeSink>();
  /** 15 s cache of the onchain leaderboard, so /leaderboard doesn't hammer the node. */
  private board: { at: number; rows: LeaderboardRow[] } | null = null;

  /**
   * `publicUrl` (no trailing slash) is where this server is reachable; match
   * token uris are built from it. Empty: the uri is just the path.
   */
  constructor(
    private readonly client: ChainClient,
    private readonly classes: ClassIds,
    private readonly publicUrl = "",
  ) {}

  onNotice(sink: NoticeSink) {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** Find (or create) the classes this deployment mints in. Throws with the chain's reason on failure. */
  static async bootstrap(client: ChainClient, denom: string): Promise<ClassIds> {
    const owned = await client.classesByOwner(client.address);
    const bySymbol = new Map(owned.map((c) => [c.symbol, c.classId]));
    const missing = CLASS_SPECS.filter((spec) => !bySymbol.has(spec.symbol));
    if (missing.length > 0) {
      await client.broadcast(missing.map((spec) => createClassMsg(client.address, spec, denom)), "battle-royale: create classes");
      const now = await client.classesByOwner(client.address);
      for (const c of now) bySymbol.set(c.symbol, c.classId);
    }
    const ids = {} as ClassIds;
    for (const spec of CLASS_SPECS) {
      const id = bySymbol.get(spec.symbol);
      if (!id) throw new Error(`class ${spec.symbol} still missing after creation (is the relayer an x/rep member?)`);
      ids[spec.key] = id;
    }
    return ids;
  }

  /** Record a finished match. Nothing is written when no participant linked a wallet. */
  async recordMatch(match: MatchRecord, entries: MatchEntry[]): Promise<void> {
    const map = match.map;
    const linked = entries.filter((e) => e.address);
    if (linked.length === 0) return;
    const touched: string[] = [];
    const msgs: EncodeObject[] = [];
    const notices: { address: string; notice: Web3Notice }[] = [];
    let winner: MatchEntry | undefined;

    try {
      for (const entry of linked) {
        const record = await this.ensureCareer(entry.address, entry.name);
        const before = record.stats;
        const merged = mergeCareer(before, entry);
        const unlocked = newAchievements(merged, entry, before.achievements);
        merged.achievements = [...before.achievements, ...unlocked.map((a) => a.code)];
        record.stats = merged;
        touched.push(entry.address);

        const meta = tokenMetadata(
          `${merged.name} — Battle Royale Career`,
          "Lifetime record kept by the Spark Dream battle royale.",
          careerToAttributes(merged),
        );
        msgs.push(record.tokenId !== null
          ? {
              typeUrl: MSG_UPDATE_TOKEN,
              value: {
                owner: this.client.address,
                classId: BigInt(this.classes.career),
                tokenId: BigInt(record.tokenId),
                metadata: meta,
              },
            }
          : this.mint("career", entry.address, meta));

        for (const a of unlocked) {
          msgs.push(this.mint("badge", entry.address, tokenMetadata(
            `${a.title} — ${merged.name}`,
            a.description,
            [
              { key: "achievement", value: a.code },
              { key: "player", value: merged.name.slice(0, 32) },
            ],
          )));
        }
        if (entry.place === 1) winner = entry;
        notices.push({
          address: entry.address,
          notice: { career: merged, newAchievements: unlocked.map((a) => a.code), matchId: match.id, txHashes: [] },
        });
      }

      // The match record: minimal attributes, the full result behind the uri,
      // its hash onchain. Held by the relayer, it is a ledger entry, not a collectible.
      // It goes first: broadcasts are chunked, and careers point at it (last_match).
      const { hash } = encodeMatchRecord(match);
      msgs.unshift(this.mint("match", this.client.address, tokenMetadata(
        `Match ${match.id}`,
        `Battle royale on map ${map.id}; the uri serves the full result, uriHash is its sha256.`,
        [
          { key: "match", value: match.id },
          { key: "map", value: map.id },
          { key: "seed", value: String(map.seed) },
          { key: "ended", value: String(match.endedAt) },
          { key: "players", value: String(match.players.length) },
          { key: "winner", value: match.winner.slice(0, 32) },
          ...(winner ? [{ key: "winner_address", value: winner.address }] : []),
        ],
        `${this.publicUrl}${MATCH_RECORD_PATH}/${match.id}`,
        hash,
      )));

      if (winner) {
        msgs.push(this.mint("map", winner.address, tokenMetadata(
          `Map ${map.id} — champion ${winner.name}`,
          "Won on this map layout; the seed regenerates the exact ground it was won on.",
          [
            { key: "map", value: map.id },
            { key: "seed", value: String(map.seed) },
            { key: "won_by", value: winner.name.slice(0, 32) },
            { key: "kills", value: String(winner.kills) },
            { key: "won_at", value: String(Math.floor(Date.now() / 1000)) },
          ],
        )));
        for (const n of notices) {
          if (n.address === winner.address) n.notice.mapToken = { mapId: map.id };
        }
      }

      const hashes = await this.client.broadcast(msgs, `battle-royale match ${match.id}`);
      this.board = null;
      // First match: learn the minted career token's id, or the next one would mint again.
      await Promise.all(touched.map(async (address) => {
        const record = this.careers.get(address);
        if (!record || record.tokenId !== null) return;
        const tokens = await this.client.tokensByOwner(address);
        const token = tokens.find((t) => t.classId === this.classes.career);
        if (token) record.tokenId = token.tokenId;
      }));
      for (const n of notices) {
        n.notice.txHashes = hashes;
        for (const sink of this.sinks) if (sink(n.address, n.notice)) break;
      }
    } catch (err) {
      // Forget our optimistic view (a query or the broadcast failed) so the
      // next match starts from the chain. A chunked broadcast may have landed
      // partly; the chain is right either way, our cache isn't.
      console.error("onchain match record failed:", err);
      for (const address of touched) this.careers.delete(address);
      throw err;
    }
  }

  /** Every career token onchain, ranked like the local leaderboard. */
  async chainLeaderboard(limit: number): Promise<LeaderboardRow[]> {
    if (this.board && Date.now() - this.board.at < 15_000) return this.board.rows.slice(0, limit);
    const tokens = await this.client.tokensOfClass(this.classes.career);
    const rows = tokens
      .map((t) => ({ token: t, stats: careerFromAttributes(t.attributes) }))
      .filter((r) => r.stats.matches > 0)
      .map((r) => ({
        address: r.token.owner,
        name: r.stats.name,
        matches: r.stats.matches,
        wins: r.stats.wins,
        kills: r.stats.kills,
        damage: r.stats.damage,
        bestPlace: r.stats.bestPlace,
        lastPlayed: r.stats.updatedAt * 1000,
        onchain: true as const,
      }))
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.matches - b.matches);
    this.board = { at: Date.now(), rows };
    return rows.slice(0, limit);
  }

  /** The player's own tokens (career, badges, maps), for the client's web3 panel. */
  async playerTokens(address: string): Promise<ChainToken[]> {
    return this.client.tokensByOwner(address);
  }

  private mint(classKey: keyof ClassIds, recipient: string, metadata: ReturnType<typeof tokenMetadata>): EncodeObject {
    return {
      typeUrl: MSG_MINT,
      value: {
        minter: this.client.address,
        classId: BigInt(this.classes[classKey]),
        entries: [{ recipient, metadata }],
        acceptedContentLicense: "CC0-1.0",
      },
    };
  }

  /** Cache a player's career, reading their token from the chain on first sight. */
  private async ensureCareer(address: string, name: string): Promise<CareerRecord> {
    const cached = this.careers.get(address);
    if (cached) return cached;
    const tokens = await this.client.tokensByOwner(address);
    const token = tokens.find((t) => t.classId === this.classes.career);
    const record: CareerRecord = token
      ? { stats: careerFromAttributes(token.attributes), tokenId: token.tokenId }
      : { stats: emptyCareer(name), tokenId: null };
    this.careers.set(address, record);
    return record;
  }
}

function tokenMetadata(name: string, description: string, attributes: { key: string; value: string }[], uri = "", uriHash = "") {
  return { name, description, uri, uriHash, attributes };
}
