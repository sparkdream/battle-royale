import { DEVNET_CHAIN, type ChainConfig } from "@br/shared";

/** Everything the chain client needs, from env (see README for the list). */
export interface ChainModuleConfig {
  /** CHAIN_ENABLED=1: record matches onchain. Default off: the game runs exactly as before. */
  enabled: boolean;
  chain: ChainConfig;
  /** The relayer account: a funded, x/rep-membered key that signs every game tx. */
  mnemonic: string;
  /** Tx memo, so game writes are recognisable in explorers. */
  memo: string;
  /** PUBLIC_URL: this server's public origin, the base of match token uris. "" → path only. */
  publicUrl: string;
}

const flag = (name: string) => /^(1|true|yes|on)$/i.test(process.env[name] ?? "");

export function loadChainConfig(): ChainModuleConfig {
  const d = DEVNET_CHAIN;
  const chain: ChainConfig = {
    chainId: process.env.CHAIN_ID ?? d.chainId,
    chainName: process.env.CHAIN_NAME ?? d.chainName,
    rpcEndpoint: process.env.CHAIN_RPC ?? d.rpcEndpoint,
    lcdEndpoint: process.env.CHAIN_LCD ?? d.lcdEndpoint,
    denom: process.env.CHAIN_DENOM ?? d.denom,
    displayDenom: process.env.CHAIN_DISPLAY_DENOM ?? d.displayDenom,
    gasPrice: process.env.CHAIN_GAS_PRICE ?? d.gasPrice,
    explorerUrl: process.env.CHAIN_EXPLORER ?? d.explorerUrl,
    bech32Prefix: process.env.CHAIN_PREFIX ?? d.bech32Prefix,
  };
  const mnemonic = process.env.CHAIN_MNEMONIC ?? "";
  const enabled = flag("CHAIN_ENABLED") && mnemonic !== "";
  if (flag("CHAIN_ENABLED") && mnemonic === "") {
    console.error("CHAIN_ENABLED is set but CHAIN_MNEMONIC is empty; running without onchain recording.");
  }
  const publicUrl = (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return { enabled, chain, mnemonic, memo: process.env.CHAIN_MEMO ?? "battle-royale", publicUrl };
}
