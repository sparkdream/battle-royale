/**
 * Keplr connection and the wallet-login flow. The game server is the source
 * of truth for which chain we're on (GET /chain-status), so the client and
 * the relayer always agree; everything web3 is hidden when it reports
 * disabled.
 */

import {
  AUTH_NONCE_PATH, AUTH_VERIFY_PATH, CHAIN_STATUS_PATH, WEB3_TOKENS_PATH,
  buildKeplrChainInfo, type AttributePair, type ChainStatus,
} from "@br/shared";

/** What window.keplr gives us; structural, so no @keplr-wallet/types needed. */
interface KeplrWindow {
  experimentalSuggestChain(info: unknown): Promise<void>;
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string; pubKey: Uint8Array }>;
  signArbitrary(chainId: string, signer: string, data: string): Promise<{ signature: string }>;
}

declare global {
  interface Window {
    keplr?: KeplrWindow;
  }
}

export interface WalletKey {
  address: string;
  /** Compressed pubkey, base64 — what the server verifies. */
  pubKey: string;
}

let status: ChainStatus | null = null;

export async function loadChainStatus(serverUrl: string): Promise<ChainStatus | null> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}${CHAIN_STATUS_PATH}`);
    status = await res.json();
  } catch {
    status = null;
  }
  return chainStatus();
}

export function chainStatus(): ChainStatus | null {
  return status?.enabled ? status : null;
}

export function explorerTxUrl(hash: string): string | null {
  const base = chainStatus()?.chain.explorerUrl;
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}

export function keplrAvailable(): boolean {
  return typeof window !== "undefined" && !!window.keplr;
}

/** Suggest the chain (first time) and unlock the account. */
export async function connectKeplr(): Promise<WalletKey> {
  const s = chainStatus();
  if (!s || !window.keplr) throw new Error(s ? "Keplr is not installed" : "Onchain mode is off on this server");
  try {
    await window.keplr.experimentalSuggestChain(buildKeplrChainInfo(s.chain));
  } catch {
    // Already suggested; enabling is what matters.
  }
  await window.keplr.enable(s.chain.chainId);
  const key = await window.keplr.getKey(s.chain.chainId);
  return { address: key.bech32Address, pubKey: toBase64(key.pubKey) };
}

/** Sign the server's nonce; the ticket it returns goes in JoinOptions.ticket. One Keplr popup. */
export async function proveAddress(serverUrl: string, key: WalletKey): Promise<string | null> {
  const s = chainStatus();
  if (!s || !window.keplr) return null;
  const base = serverUrl.replace(/\/$/, "");
  const nonceRes = await fetch(`${base}${AUTH_NONCE_PATH}?address=${encodeURIComponent(key.address)}`);
  if (!nonceRes.ok) throw new Error((await nonceRes.json().catch(() => ({}))).error ?? "could not get a nonce");
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const signed = await window.keplr.signArbitrary(s.chain.chainId, key.address, nonce);
  const verifyRes = await fetch(`${base}${AUTH_VERIFY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: key.address, pubKey: key.pubKey, signature: signed.signature, nonce }),
  });
  if (!verifyRes.ok) return null;
  const { ticket } = (await verifyRes.json()) as { ticket?: string };
  return ticket || null;
}

export interface OwnedToken {
  classId: string;
  tokenId: string;
  name: string;
  attributes: AttributePair[];
}

/** The player's career, badges and map tokens, proxied through the game server. */
export async function fetchMyTokens(serverUrl: string, address: string): Promise<OwnedToken[]> {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}${WEB3_TOKENS_PATH}?address=${encodeURIComponent(address)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { tokens?: OwnedToken[] };
  return body.tokens ?? [];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
