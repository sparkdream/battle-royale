import { describe, expect, it } from "vitest";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { createHash } from "node:crypto";
import { careerFromAttributes, type MatchEntry, type MatchRecord, type Web3Notice } from "@br/shared";
import type { ChainClient, ChainToken } from "./client";
import { Web3Recorder } from "./recorder";

const DENOM = "usparz.sparkdreamdev";

/** An in-memory x/artifact: mints land as tokens, classes are creatable. */
class FakeChain implements ChainClient {
  address = "sprkdrm1relayer";
  canCreateClasses = true;
  private classes: { classId: string; symbol: string; owner: string }[] = [];
  private tokens: ChainToken[] = [];
  private nextClass = 1;
  private nextToken = 1;
  broadcasts: EncodeObject[][] = [];
  failBroadcast = false;
  failQueries = false;

  async broadcast(msgs: readonly EncodeObject[]): Promise<string[]> {
    if (this.failBroadcast) throw new Error("simulated outage");
    this.broadcasts.push([...msgs]);
    for (const msg of msgs) {
      const value = msg.value as {
        symbol?: string;
        classId?: bigint;
        entries?: { recipient: string; metadata: { name: string; attributes: { key: string; value: string }[] } }[];
      };
      if (msg.typeUrl.endsWith("MsgCreateClass") && value.symbol) {
        this.classes.push({ classId: String(this.nextClass++), symbol: value.symbol, owner: this.address });
      }
      if (msg.typeUrl.endsWith("MsgMint") && value.classId !== undefined) {
        for (const entry of value.entries ?? []) {
          this.tokens.push({
            classId: value.classId.toString(),
            tokenId: String(this.nextToken++),
            owner: entry.recipient || this.address,
            name: entry.metadata.name,
            attributes: entry.metadata.attributes,
          });
        }
      }
    }
    return ["HASH1"];
  }

  async classesByOwner(owner: string) {
    return this.classes.filter((c) => c.owner === owner).map(({ classId, symbol }) => ({ classId, symbol }));
  }

  async tokensByOwner(owner: string) {
    if (this.failQueries) throw new Error("simulated LCD outage");
    return this.tokens.filter((t) => t.owner === owner);
  }

  async tokensOfClass(classId: string) {
    return this.tokens.filter((t) => t.classId === classId);
  }
}

function entry(over: Partial<MatchEntry> = {}): MatchEntry {
  return {
    address: "sprkdrm1ada",
    name: "Ada",
    place: 1,
    kills: 3,
    damage: 400,
    survivedSeconds: 100,
    items: { "1": 1, "10": 2 },
    crates: 1,
    mapId: "m1",
    mapSeed: 7,
    matchId: "0123456789abcdef",
    ...over,
  };
}

function match(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: "0123456789abcdef",
    game: "battle-royale",
    map: { id: "m1", seed: 7 },
    difficulty: "normal",
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_200,
    humans: 2,
    bots: 8,
    winner: "Ada",
    players: [
      { name: "Ada", bot: false, address: "sprkdrm1ada", place: 1, kills: 3, damage: 400, survivedSeconds: 200, items: { "1": 1 }, crates: 1 },
      { name: "Bot 1", bot: true, place: 2, kills: 0, damage: 0, survivedSeconds: 190, items: {}, crates: 0 },
    ],
    ...over,
  };
}

function mintMetadata(msg: EncodeObject) {
  return mintEntries(msg)[0]?.metadata as { attributes: { key: string; value: string }[]; uri?: string; uriHash?: string } | undefined;
}

function mintEntries(msg: EncodeObject) {
  return (msg.value as { entries?: { recipient: string; metadata: { attributes: { key: string; value: string }[] } }[] }).entries ?? [];
}

async function recorder(fake = new FakeChain(), publicUrl = "") {
  const classes = await Web3Recorder.bootstrap(fake, DENOM);
  return { fake, recorder: new Web3Recorder(fake, classes, publicUrl) };
}

describe("Web3Recorder", () => {
  it("bootstraps the four classes once and finds them again", async () => {
    const fake = new FakeChain();
    await recorder(fake);
    await recorder(fake);
    const created = fake.broadcasts.flat().filter((m) => m.typeUrl.endsWith("MsgCreateClass"));
    expect(created).toHaveLength(4);
  });

  it("with a session key, refuses to start until the granter has created the classes", async () => {
    const fake = new FakeChain();
    fake.canCreateClasses = false;
    await expect(Web3Recorder.bootstrap(fake, DENOM)).rejects.toThrow(/BRCAREER, BRBADGE, BRMAP, BRMATCH/);
    expect(fake.broadcasts).toHaveLength(0);
    // once they exist (created with the account's own key), it finds them
    fake.canCreateClasses = true;
    await Web3Recorder.bootstrap(fake, DENOM);
    fake.canCreateClasses = false;
    const classes = await Web3Recorder.bootstrap(fake, DENOM);
    expect(Object.keys(classes).sort()).toEqual(["badge", "career", "map", "match"]);
  });

  it("first match: mints career tokens, badges, and the winner's map token", async () => {
    const { fake, recorder: rec } = await recorder();
    const notices: Web3Notice[] = [];
    rec.onNotice((address, notice) => {
      notices.push(notice);
      return address === "sprkdrm1ada";
    });
    await rec.recordMatch(match(), [
      entry({ place: 1, kills: 3 }),
      entry({ address: "sprkdrm1bob", name: "Bob", place: 2, kills: 1 }),
    ]);

    const msgs = fake.broadcasts.flat();
    const mints = msgs.filter((m) => m.typeUrl.endsWith("MsgMint"));
    const updates = msgs.filter((m) => m.typeUrl.endsWith("MsgUpdateToken"));
    expect(updates).toHaveLength(0);
    // Two careers + dropped-in/first-blood/last-one-standing for Ada + dropped-in/first-blood for Bob
    // + map token for Ada + the match token.
    expect(mints).toHaveLength(9);

    // The match token also carries "map"; the map token is the one without "match".
    const mapMint = mints.find((m) => {
      const attrs = mintEntries(m)[0]?.metadata.attributes ?? [];
      return attrs.some((a) => a.key === "map" && a.value === "m1") && !attrs.some((a) => a.key === "match");
    });
    expect(mapMint).toBeDefined();
    expect(mintEntries(mapMint!)[0].recipient).toBe("sprkdrm1ada");

    const adaNotice = notices.find((n) => n.career.matches === 1);
    expect(adaNotice).toBeDefined();
    expect(adaNotice!.newAchievements).toEqual(expect.arrayContaining(["first-blood", "last-one-standing"]));
    expect(adaNotice!.mapToken).toEqual({ mapId: "m1" });
    expect(adaNotice!.matchId).toBe("0123456789abcdef");
    expect(adaNotice!.career.kills).toBe(3);
    expect(adaNotice!.career.items).toEqual({ "1": 1, "10": 2 });
    expect(adaNotice!.career.lastMatch).toBe("0123456789abcdef");
  });

  it("mints one match token to the relayer, its uri hash the sha256 of the record", async () => {
    const record = match();
    const { fake, recorder: rec } = await recorder(new FakeChain(), "https://battle.example");
    await rec.recordMatch(record, [entry()]);

    const mints = fake.broadcasts.flat().filter((m) => m.typeUrl.endsWith("MsgMint"));
    const matchMint = mints.find((m) => mintMetadata(m)?.attributes.some((a) => a.key === "match"));
    expect(matchMint).toBeDefined();
    expect(mintEntries(matchMint!)[0].recipient).toBe(fake.address);
    const meta = mintMetadata(matchMint!)!;
    expect(meta.uri).toBe("https://battle.example/matches/0123456789abcdef");
    expect(meta.uriHash).toBe(createHash("sha256").update(JSON.stringify(record)).digest("hex"));
    const attrs = Object.fromEntries(meta.attributes.map((a) => [a.key, a.value]));
    expect(attrs).toMatchObject({ match: "0123456789abcdef", map: "m1", seed: "7", players: "2", winner: "Ada", winner_address: "sprkdrm1ada" });
    // The match token is the relayer's, not the player's.
    expect((await fake.tokensByOwner("sprkdrm1ada")).some((t) => t.attributes.some((a) => a.key === "match"))).toBe(false);
  });

  it("writes nothing for a match without linked players", async () => {
    const { fake, recorder: rec } = await recorder();
    fake.broadcasts.length = 0;
    await rec.recordMatch(match(), [entry({ address: "" })]);
    expect(fake.broadcasts).toHaveLength(0);
  });

  it("second match: updates the career token instead of minting another", async () => {
    const { fake, recorder: rec } = await recorder();
    await rec.recordMatch(match(), [entry({ place: 1, kills: 3 })]);
    fake.broadcasts.length = 0;
    await rec.recordMatch(match({ id: "fedcba9876543210", map: { id: "m2", seed: 8 }, winner: "" }), [
      entry({ place: 2, kills: 0, mapId: "m2", mapSeed: 8, matchId: "fedcba9876543210" }),
    ]);

    const msgs = fake.broadcasts.flat();
    expect(msgs.filter((m) => m.typeUrl.endsWith("MsgMint")).some((m) =>
      mintEntries(m)[0]?.metadata.attributes.some((a) => a.key === "matches"),
    )).toBe(false);
    const update = msgs.find((m) => m.typeUrl.endsWith("MsgUpdateToken"));
    expect(update).toBeDefined();
    const meta = (update!.value as { metadata: { attributes: { key: string; value: string }[] } }).metadata;
    const stats = careerFromAttributes(meta.attributes);
    expect(stats.matches).toBe(2);
    expect(stats.lastMatch).toBe("fedcba9876543210");
    // No repeat badges; the second match's winner is nobody (place 2), so no map mint either: only the match token.
    expect(msgs.filter((m) => m.typeUrl.endsWith("MsgMint"))).toHaveLength(1);
  });

  it("one wallet playing twice in a match gets one career token holding both results", async () => {
    const { fake, recorder: rec } = await recorder();
    await rec.recordMatch(match(), [
      entry({ place: 1, kills: 3 }),
      entry({ place: 2, kills: 1 }),
    ]);
    const careers = (await fake.tokensByOwner("sprkdrm1ada")).filter((t) => t.classId === "1");
    expect(careers).toHaveLength(1);
    expect(careerFromAttributes(careers[0].attributes)).toMatchObject({ matches: 2, kills: 4, wins: 1 });

    fake.broadcasts.length = 0;
    await rec.recordMatch(match(), [entry({ place: 1 }), entry({ place: 2 })]);
    const msgs = fake.broadcasts.flat();
    expect(msgs.filter((m) => m.typeUrl.endsWith("MsgUpdateToken"))).toHaveLength(1);
  });

  it("a failed broadcast evicts the cache so the next match resumes from the chain", async () => {
    const { fake, recorder: rec } = await recorder();
    await rec.recordMatch(match(), [entry()]);
    fake.broadcasts.length = 0;

    fake.failBroadcast = true;
    await expect(rec.recordMatch(match({ id: "fedcba9876543210" }), [entry({ kills: 5 })])).rejects.toThrow();
    fake.failBroadcast = false;

    await rec.recordMatch(match({ id: "1111111111111111" }), [entry({ kills: 1 })]);
    const msgs = fake.broadcasts.flat();
    // The chain still has the career token from match 1, so this is an update, not a mint.
    expect(msgs.some((m) => m.typeUrl.endsWith("MsgUpdateToken"))).toBe(true);
    const meta = (msgs.find((m) => m.typeUrl.endsWith("MsgUpdateToken"))!.value as { metadata: { attributes: { key: string; value: string }[] } }).metadata;
    // Match 2 never landed, so the career holds matches 1 + 3.
    expect(careerFromAttributes(meta.attributes).matches).toBe(2);
  });

  it("a failed career query mid-match evicts the players already merged", async () => {
    const { fake, recorder: rec } = await recorder();
    await rec.recordMatch(match(), [entry()]);
    fake.broadcasts.length = 0;

    // Ada is cached; Bob's first-sight query fails after Ada's stats were merged.
    fake.failQueries = true;
    await expect(rec.recordMatch(match({ id: "fedcba9876543210" }), [
      entry({ kills: 5, matchId: "fedcba9876543210" }),
      entry({ address: "sprkdrm1bob", name: "Bob", place: 2 }),
    ])).rejects.toThrow(/outage/);
    fake.failQueries = false;
    expect(fake.broadcasts).toHaveLength(0);

    await rec.recordMatch(match({ id: "1111111111111111" }), [entry({ kills: 1, matchId: "1111111111111111" })]);
    const update = fake.broadcasts.flat().find((m) => m.typeUrl.endsWith("MsgUpdateToken"))!;
    const stats = careerFromAttributes((update.value as { metadata: { attributes: { key: string; value: string }[] } }).metadata.attributes);
    // Matches 1 and 3 only: the phantom match 2 (5 kills) never counted.
    expect(stats).toMatchObject({ matches: 2, kills: 4, lastMatch: "1111111111111111" });
  });

  it("puts the match token first so chunked broadcasts land it before the careers that point at it", async () => {
    const { fake, recorder: rec } = await recorder();
    await rec.recordMatch(match(), [entry()]);
    const first = fake.broadcasts.flat().find((m) => m.typeUrl.endsWith("MsgMint"))!;
    expect(mintMetadata(first)!.attributes.some((a) => a.key === "match")).toBe(true);
  });

  it("chainLeaderboard ranks and skips empty tokens", async () => {
    const { recorder: rec } = await recorder();
    await rec.recordMatch(match(), [
      entry({ place: 1 }),
      entry({ address: "sprkdrm1bob", name: "Bob", place: 2 }),
    ]);
    await rec.recordMatch(match({ id: "fedcba9876543210" }), [entry({ address: "sprkdrm1bob", name: "Bob", place: 1 })]);

    const rows = await rec.chainLeaderboard(10);
    // Both have 1 win; Ada's 3 kills beat Bob's 1, and Bob's later win does not outrank her.
    expect(rows.map((r) => r.name)).toEqual(["Ada", "Bob"]);
    expect(rows.every((r) => r.onchain && r.address.startsWith("sprkdrm1"))).toBe(true);
  });
});
