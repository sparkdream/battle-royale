/**
 * The game server's connection to a Spark Dream chain, via sparkdreamjs:
 * `getSigningSparkdreamClient` for txs and the LCD client for queries.
 *
 * Two ways to sign (config.ts):
 * - key mode: the relayer's own mnemonic signs every tx and may create classes.
 * - session mode: a session key, granted by the game management account
 *   through x/session, signs `MsgExecSession` wrappers; the chain executes
 *   the inner mints and updates as the granter and takes the fees from the
 *   grant's spend limit. The key file is re-read before every tx so a
 *   rotation needs no restart. Classes must already exist: MsgCreateClass is
 *   not delegable.
 *
 * Exposed as the narrow `ChainClient` interface so tests can fake it; the
 * recorder never touches cosmjs directly.
 */

import { readFileSync } from "node:fs";
import type { EncodeObject, Registry } from "@cosmjs/proto-signing";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { fromBase64 } from "@cosmjs/encoding";
import type { SigningStargateClient } from "@cosmjs/stargate";
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
  /** The relayer's address (class owner / minter): the granter, in session mode. */
  readonly address: string;
  /** Key mode only: a session grant covers mints and updates, never MsgCreateClass. */
  readonly canCreateClasses: boolean;
  /** Signs and broadcasts; resolves to the tx hashes in order. Serialized per client. */
  broadcast(msgs: readonly EncodeObject[], memo: string): Promise<string[]>;
  classesByOwner(owner: string): Promise<OwnedClassInfo[]>;
  tokensByOwner(owner: string): Promise<ChainToken[]>;
  tokensOfClass(classId: string): Promise<ChainToken[]>;
}

export const MSG_EXEC_SESSION = "/sparkdream.session.v1.MsgExecSession";

/** Wrap messages (≤10) for a session key to execute as `granter`. */
export function sessionExec(registry: Registry, grantee: string, granter: string, msgs: readonly EncodeObject[]): EncodeObject {
  if (msgs.length === 0 || msgs.length > 10) throw new Error(`a session exec carries 1–10 messages, not ${msgs.length}`);
  return { typeUrl: MSG_EXEC_SESSION, value: { grantee, granter, msgs: msgs.map((m) => registry.encodeAsAny(m)) } };
}

/** How txs get signed: the relayer's own key, or a session key read from a file. */
interface Signer {
  /** The address whose messages are executed (class owner, minter). */
  address: string;
  canCreateClasses: boolean;
  /** The signing client and the account that signs; rebuilt when the session key file changes. */
  client(): Promise<{ signing: SigningStargateClient; sender: string }>;
}

async function keySigner(cfg: ChainModuleConfig): Promise<Signer> {
  const { chain } = cfg;
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(cfg.mnemonic, { prefix: chain.bech32Prefix });
  const [{ address }] = await wallet.getAccounts();
  const signing = await getSigningSparkdreamClient({ rpcEndpoint: chain.rpcEndpoint, signer: wallet });
  return { address, canCreateClasses: true, client: async () => ({ signing, sender: address }) };
}

function sessionSigner(cfg: ChainModuleConfig): Signer {
  const { chain } = cfg;
  const { keyFile, granter } = cfg.session!;
  let current: { mnemonic: string; signing: SigningStargateClient; sender: string } | null = null;
  return {
    address: granter,
    canCreateClasses: false,
    async client() {
      let mnemonic: string;
      try {
        mnemonic = readFileSync(keyFile, "utf8").trim();
      } catch {
        throw new Error(`session key ${keyFile} is not there yet (the launcher delivers it after the grant)`);
      }
      if (!current || current.mnemonic !== mnemonic) {
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: chain.bech32Prefix });
        const [{ address }] = await wallet.getAccounts();
        const signing = await getSigningSparkdreamClient({ rpcEndpoint: chain.rpcEndpoint, signer: wallet });
        current?.signing.disconnect();
        current = { mnemonic, signing, sender: address };
      }
      return { signing: current.signing, sender: current.sender };
    },
  };
}

export async function connectChain(cfg: ChainModuleConfig): Promise<ChainClient> {
  const { chain } = cfg;
  const signer = cfg.session ? sessionSigner(cfg) : await keySigner(cfg);
  const { address } = signer;
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
    canCreateClasses: signer.canCreateClasses,

    broadcast: (msgs, memo) =>
      enqueue(async () => {
        const hashes: string[] = [];
        const { signing, sender } = await signer.client();
        // max_batch_size (50 mint entries) bounds one MsgMint; chunk whole
        // messages so a big match never exceeds the block gas limit either
        // (and a session exec carries at most 10).
        for (let i = 0; i < msgs.length; i += 8) {
          const inner = msgs.slice(i, i + 8);
          const chunk = cfg.session ? [sessionExec(signing.registry, sender, address, inner)] : inner;
          const gas = await signing.simulate(sender, chunk, memo);
          const limit = Math.ceil(gas * 1.3);
          const fee = {
            amount: [{ denom: gasDenom, amount: String(Math.ceil(limit * gasAmount)) }],
            gas: String(limit),
          };
          const result = await signing.signAndBroadcast(sender, chunk, fee, memo);
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
