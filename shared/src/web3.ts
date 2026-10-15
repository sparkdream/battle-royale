/**
 * Spark Dream chain integration: the types and helpers both sides share.
 * The server writes career records, achievement badges and map tokens
 * onchain through x/artifact; the client connects Keplr to the same chain
 * and reads the tokens back. Everything here is transport-free so it works
 * on both sides of the wire.
 */

import type { ItemCounts } from "./achievements";

/** A Spark Dream network the game can talk to. */
export interface ChainConfig {
  chainId: string;
  chainName: string;
  /** CometBFT RPC (tx broadcast), e.g. https://rpc-dev.sparkdream.io */
  rpcEndpoint: string;
  /** LCD / gRPC-gateway REST (queries), e.g. https://api-dev.sparkdream.io */
  lcdEndpoint: string;
  denom: string;
  displayDenom: string;
  /** Gas price as "<amount><denom>", the format cosmjs wants. */
  gasPrice: string;
  explorerUrl: string;
  bech32Prefix: string;
}

/** The sparkdream devnet. The server's env can override every field. */
export const DEVNET_CHAIN: ChainConfig = {
  chainId: "sparkdream-dev-1",
  chainName: "Spark Dream Devnet",
  rpcEndpoint: "https://rpc-dev.sparkdream.io",
  lcdEndpoint: "https://api-dev.sparkdream.io",
  denom: "usparz.sparkdreamdev",
  displayDenom: "SPARK",
  gasPrice: "0.025usparz.sparkdreamdev",
  explorerUrl: "https://explorer-devnet.sparkdream.io/sparkdream",
  bech32Prefix: "sprkdrm",
};

/** Coin decimals for gas display (Spark Dream uses micro-units). */
export const CHAIN_DECIMALS = 6;

/** `experimentalSuggestChain` payload for Keplr. Same shape sparkdream-ui sends. */
export function buildKeplrChainInfo(c: ChainConfig) {
  return {
    chainId: c.chainId,
    chainName: c.chainName,
    rpc: c.rpcEndpoint,
    rest: c.lcdEndpoint,
    bip44: { coinType: 118 },
    bech32Config: {
      bech32PrefixAccAddr: c.bech32Prefix,
      bech32PrefixAccPub: `${c.bech32Prefix}pub`,
      bech32PrefixValAddr: `${c.bech32Prefix}valoper`,
      bech32PrefixValPub: `${c.bech32Prefix}valoperpub`,
      bech32PrefixConsAddr: `${c.bech32Prefix}valcons`,
      bech32PrefixConsPub: `${c.bech32Prefix}valconspub`,
    },
    currencies: [{ coinDenom: c.displayDenom, coinMinimalDenom: c.denom, coinDecimals: CHAIN_DECIMALS }],
    feeCurrencies: [{
      coinDenom: c.displayDenom,
      coinMinimalDenom: c.denom,
      coinDecimals: CHAIN_DECIMALS,
      gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
    }],
    stakeCurrency: { coinDenom: c.displayDenom, coinMinimalDenom: c.denom, coinDecimals: CHAIN_DECIMALS },
    features: ["ibc-transfer", "ibc-go"],
  };
}

// HTTP routes on the game server (companions to LEADERBOARD_PATH).
export const CHAIN_STATUS_PATH = "/chain-status";
export const AUTH_NONCE_PATH = "/auth/nonce";
export const AUTH_VERIFY_PATH = "/auth/verify";
/** The connected player's tokens (career, badges, maps), proxied by the server. */
export const WEB3_TOKENS_PATH = "/web3/tokens";
/** `GET /matches/<id>`: a finished match's full result, the document a match token's uri points at. */
export const MATCH_RECORD_PATH = "/matches";

/** Response of GET /chain-status; tells the client whether web3 mode exists. */
export interface ChainStatus {
  enabled: boolean;
  /** Set when enabled: the chain the server writes to, for Keplr. */
  chain: ChainConfig;
  /** The server's relayer address once the chain client is up. */
  relayer?: string;
}

/**
 * A linked player's lifetime record, stored as the attributes of their
 * soulbound career token. Attribute values are capped at 256 chars onchain,
 * so counts stay compact (see careerToAttributes).
 */
export interface CareerStats {
  name: string;
  matches: number;
  wins: number;
  kills: number;
  damage: number;
  /** Best finishing place, 1 = won; 0 = no match finished yet. */
  bestPlace: number;
  /** Distinct map layouts played. */
  mapsPlayed: number;
  items: ItemCounts;
  crates: number;
  /** Achievement codes in unlock order (see achievements.ts). */
  achievements: string[];
  /** Id of the last match folded in (its match token/record); "" before the first. */
  lastMatch: string;
  /** Map id of the last match, so a new layout can be told from a replay of the same one. */
  lastMap: string;
  /** Unix seconds of the last onchain update. */
  updatedAt: number;
}

export function emptyCareer(name: string): CareerStats {
  return {
    name, matches: 0, wins: 0, kills: 0, damage: 0, bestPlace: 0, mapsPlayed: 0,
    items: {}, crates: 0, achievements: [], lastMatch: "", lastMap: "", updatedAt: 0,
  };
}

/** One player's result in a finished match, the unit the server records. */
export interface MatchEntry {
  address: string;
  name: string;
  place: number;
  kills: number;
  damage: number;
  survivedSeconds: number;
  items: ItemCounts;
  crates: number;
  mapId: string;
  mapSeed: number;
  /** The match this result belongs to (see MatchRecord.id). */
  matchId: string;
}

/** One participant's line in a match record (bots included). */
export interface MatchParticipant {
  name: string;
  bot: boolean;
  /** Linked wallet, when the player had one. */
  address?: string;
  place: number;
  kills: number;
  damage: number;
  survivedSeconds: number;
  items: ItemCounts;
  crates: number;
}

/**
 * A finished match, the document behind a match token. The server stores it
 * verbatim and serves it at MATCH_RECORD_PATH/<id>; the token's uriHash is
 * the sha256 of the served bytes, so anyone can check the record against the
 * chain. Field order matters: it is the hashed serialization.
 */
export interface MatchRecord {
  id: string;
  game: "battle-royale";
  map: { id: string; seed: number };
  difficulty: string;
  /** Unix seconds. */
  startedAt: number;
  endedAt: number;
  humans: number;
  bots: number;
  /** Winner's name, "" when nobody survived (everyone left). */
  winner: string;
  /** Best place first. Players who disconnected before being eliminated are missing. */
  players: MatchParticipant[];
}

/** Fold a match entry into a career (pure; achievements are evaluated after). */
export function mergeCareer(career: CareerStats, entry: MatchEntry): CareerStats {
  const items = { ...career.items };
  for (const [type, n] of Object.entries(entry.items)) items[type] = (items[type] ?? 0) + n;
  return {
    name: entry.name || career.name,
    matches: career.matches + 1,
    wins: career.wins + (entry.place === 1 ? 1 : 0),
    kills: career.kills + entry.kills,
    damage: career.damage + Math.round(entry.damage),
    bestPlace: career.bestPlace === 0 ? entry.place : Math.min(career.bestPlace, entry.place),
    // Rooms keep their map across matches, so only a change of layout counts.
    mapsPlayed: career.mapsPlayed + (entry.mapId !== career.lastMap ? 1 : 0),
    items,
    crates: career.crates + entry.crates,
    achievements: career.achievements,
    lastMatch: entry.matchId,
    lastMap: entry.mapId,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Attribute pairs as x/artifact stores them. */
export interface AttributePair {
  key: string;
  value: string;
}

/** Pack a career into ≤16 token attributes (key ≤64, value ≤256 chars onchain). */
export function careerToAttributes(c: CareerStats): AttributePair[] {
  const items = Object.entries(c.items)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([type, n]) => `${type}:${n}`)
    .join(",");
  return [
    { key: "name", value: c.name.slice(0, 32) },
    { key: "matches", value: String(c.matches) },
    { key: "wins", value: String(c.wins) },
    { key: "kills", value: String(c.kills) },
    { key: "damage", value: String(c.damage) },
    { key: "best_place", value: String(c.bestPlace) },
    { key: "maps", value: String(c.mapsPlayed) },
    { key: "crates", value: String(c.crates) },
    { key: "items", value: items.slice(0, 256) },
    { key: "achievements", value: c.achievements.join(",").slice(0, 256) },
    { key: "last_match", value: c.lastMatch.slice(0, 64) },
    { key: "last_map", value: c.lastMap.slice(0, 64) },
    { key: "updated", value: String(c.updatedAt) },
  ];
}

/** Read a career back from token attributes; missing keys become defaults. */
export function careerFromAttributes(attrs: AttributePair[]): CareerStats {
  const get = (key: string) => attrs.find((a) => a.key === key)?.value ?? "";
  const num = (key: string) => {
    const n = Number(get(key));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  const items: ItemCounts = {};
  for (const pair of get("items").split(",")) {
    const m = /^(\d+):(\d+)$/.exec(pair);
    if (m) items[m[1]] = Number(m[2]);
  }
  const achievements = get("achievements").split(",").filter(Boolean);
  return {
    name: get("name"),
    matches: num("matches"),
    wins: num("wins"),
    kills: num("kills"),
    damage: num("damage"),
    bestPlace: num("best_place"),
    mapsPlayed: num("maps"),
    items,
    crates: num("crates"),
    achievements,
    lastMatch: get("last_match"),
    lastMap: get("last_map"),
    updatedAt: num("updated"),
  };
}

/** Server → client once the chain write for their match has landed. */
export interface Web3Notice {
  career: CareerStats;
  /** Achievement codes this match minted badges for. */
  newAchievements: string[];
  /** Set when this player was minted a map champion token. */
  mapToken?: { mapId: string };
  /** The match token's record id (see MATCH_RECORD_PATH). */
  matchId: string;
  txHashes: string[];
}

/** sprkdrm1qyk…x4f — bech32 addresses are too wide for the HUD. */
export function shortAddress(address: string): string {
  return address.length <= 13 ? address : `${address.slice(0, 8)}…${address.slice(-4)}`;
}
