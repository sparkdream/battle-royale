/**
 * The game server's connection to a Spark Dream chain, via sparkdreamjs:
 * `getSigningSparkdreamClient` for txs (the relayer key signs everything)
 * and `ClientFactory.createRPCQueryClient` for typed queries.
 *
 * Exposed as the narrow `ChainClient` interface so tests can fake it; the
 * recorder never touches cosmjs directly.
 */

import type { EncodeObject } from "@cosmjs/proto-signing";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { fromBase64 } from "@cosmjs/encoding";
import { getSigningSparkdreamClient, sparkdream } from "@sparkdreamnft/sparkdreamjs";
import type { AttributePair } from "@br/shared";
import type { ChainModuleConfig } from "./config";

/** A token as the game sees it, ids as strings (JSON/explorer style). */
export interface ChainToken {
  classId: string;
  tokenId: string;
  owner: string;
  name: string;
  attributes: AttributePair[];
}

export interface OwnedClassInfo {
  classId: string;
  symbol: string;
}

/** The chain surface the recorder uses. */
export interface ChainClient {
  /** The relayer's address (class owner / minter). */
  readonly address: string;
  /** Signs and broadcasts; resolves to the tx hashes in order. Serialized per client. */
  broadcast(msgs: readonly EncodeObject[], memo: string): Promise<string[]>;
  classesByOwner(owner: string): Promise<OwnedClassInfo[]>;
  tokensByOwner(owner: string): Promise<ChainToken[]>;
  tokensOfClass(classId: string): Promise<ChainToken[]>;
}

export async function connectChain(cfg: ChainModuleConfig): Promise<ChainClient> {
  const { chain } = cfg;
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(cfg.mnemonic, { prefix: chain.bech32Prefix });
  const [{ address }] = await wallet.getAccounts();
  const signing = await getSigningSparkdreamClient({ rpcEndpoint: chain.rpcEndpoint, signer: wallet });
  // The LCD query client (plain REST): the generated RPC query client wants
  // cosmjs's Tendermint34Client, which cosmjs 0.39 no longer ships.
  const query = await sparkdream.ClientFactory.createLCDClient({ restEndpoint: chain.lcdEndpoint });

  const [gasAmount, gasDenom] = parseGasPrice(chain.gasPrice);

  // One tx at a time: the signing client tracks its own sequence, and
  // parallel broadcasts would race it. A failed tx still lets the next run.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const chained = queue.then(run, run);
    queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  };

  // The gateway speaks protojson: snake_case keys and string uint64s, while
  // the generated types claim camelCase. Read both, trust neither.
  const viewToken = (raw: unknown): ChainToken => {
    const v = raw as { token?: Record<string, unknown>; class_id?: string; id?: string; owner?: string; metadata?: { name?: string; attributes?: { key: string; value: string }[] } };
    const token = v.token ?? v;
    const metadata = (token.metadata ?? {}) as { name?: string; attributes?: { key: string; value: string }[] };
    const str = (x: unknown) => (typeof x === "string" ? x : typeof x === "bigint" ? x.toString() : String(x ?? ""));
    const pick = (o: Record<string, unknown>, ...names: string[]) => {
      for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
      return undefined;
    };
    return {
      classId: str(pick(token, "class_id", "classId")),
      tokenId: str(pick(token, "id")),
      owner: str(pick(token, "owner")),
      name: metadata.name ?? "",
      attributes: (metadata.attributes ?? []).map((a) => ({ key: a.key, value: a.value })),
    };
  };
  const pageNextKey = (raw: unknown): string => {
    const p = (raw ?? {}) as { next_key?: string; nextKey?: string };
    return p.next_key ?? p.nextKey ?? "";
  };
  const viewClass = (raw: unknown): OwnedClassInfo => {
    const v = raw as { class?: Record<string, unknown> };
    const c = v.class ?? {};
    return { classId: String(c.id ?? ""), symbol: String(c.symbol ?? "") };
  };

  const client: ChainClient = {
    address,

    broadcast: (msgs, memo) =>
      enqueue(async () => {
        const hashes: string[] = [];
        // max_batch_size (50 mint entries) bounds one MsgMint; chunk whole
        // messages so a big match never exceeds the block gas limit either.
        for (let i = 0; i < msgs.length; i += 8) {
          const chunk = msgs.slice(i, i + 8);
          const gas = await signing.simulate(address, chunk, memo);
          const limit = Math.ceil(gas * 1.3);
          const fee = {
            amount: [{ denom: gasDenom, amount: String(Math.ceil(limit * gasAmount)) }],
            gas: String(limit),
          };
          const result = await signing.signAndBroadcast(address, chunk, fee, memo);
          if (result.code !== 0) throw new Error(`tx failed (${result.code}): ${result.rawLog}`);
          hashes.push(result.transactionHash);
        }
        return hashes;
      }),

    classesByOwner: async (owner) => {
      const res = (await query.sparkdream.artifact.v1.classesByOwner({ owner })) as unknown as { classes?: unknown[] };
      return (res.classes ?? []).map(viewClass);
    },

    tokensByOwner: async (owner) => {
      // classId 0 = every class the address holds tokens in. Paged: a player
      // with many badges and maps must still return their career token.
      const out: ChainToken[] = [];
      let key = new Uint8Array();
      do {
        const res = (await query.sparkdream.artifact.v1.tokensByOwner({
          owner,
          classId: BigInt(0),
          pagination: { key, offset: BigInt(0), limit: BigInt(0), countTotal: false, reverse: false },
        })) as unknown as { tokens?: unknown[]; pagination?: unknown };
        out.push(...(res.tokens ?? []).map(viewToken));
        const next = pageNextKey(res.pagination);
        key = next ? fromBase64(next) : new Uint8Array();
      } while (key.length > 0);
      return out;
    },

    tokensOfClass: async (classId) => {
      const out: ChainToken[] = [];
      let key = new Uint8Array();
      do {
        const res = (await query.sparkdream.artifact.v1.tokens({
          classId: BigInt(classId),
          pagination: { key, offset: BigInt(0), limit: BigInt(0), countTotal: false, reverse: false },
        })) as unknown as { tokens?: unknown[]; pagination?: unknown };
        out.push(...(res.tokens ?? []).map(viewToken));
        const next = pageNextKey(res.pagination);
        key = next ? fromBase64(next) : new Uint8Array();
      } while (key.length > 0);
      return out;
    },
  };
  return client;
}

function parseGasPrice(price: string): [number, string] {
  const m = /^(\d+(?:\.\d+)?)(.+)$/.exec(price.trim());
  if (!m) throw new Error(`CHAIN_GAS_PRICE "${price}" is not "<amount><denom>"`);
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`CHAIN_GAS_PRICE "${price}" has no usable amount`);
  return [amount, m[2]];
}
