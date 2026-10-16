import { DEVNET_CHAIN, type ChainConfig } from "@br/shared";

/** Everything the chain client needs, from env (see README for the list). */
export interface ChainModuleConfig {
  /** CHAIN_ENABLED=1: record matches onchain. Default off: the game runs exactly as before. */
  enabled: boolean;
  chain: ChainConfig;
  /**
   * Key mode: the relayer account's mnemonic, a funded, x/rep-membered key
   * that signs every game tx itself (and creates the classes). "" in session mode.
   */
  mnemonic: string;
  /**
   * Session mode (CHAIN_SESSION_KEY_FILE + CHAIN_GRANTER): the game signs
   * MsgMint and MsgUpdateToken through an x/session grant from `granter`,
   * the game management account, with the session key read from `keyFile`
   * before every tx (whoever grants it rotates it in place). The granter's
   * own key never reaches this server, and it must have created the classes.
   */
  session?: { keyFile: string; granter: string };
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
  let mnemonic = process.env.CHAIN_MNEMONIC ?? "";
  const keyFile = (process.env.CHAIN_SESSION_KEY_FILE ?? "").trim();
  const granter = (process.env.CHAIN_GRANTER ?? "").trim();
  let session: ChainModuleConfig["session"];
  if (keyFile || granter) {
    if (!keyFile || !granter) {
      console.error(
        "CHAIN_SESSION_KEY_FILE and CHAIN_GRANTER go together; ignoring them" +
          (mnemonic ? " and using CHAIN_MNEMONIC." : "."),
      );
    } else {
      session = { keyFile, granter };
      if (mnemonic) console.error("CHAIN_MNEMONIC is ignored in session mode (CHAIN_SESSION_KEY_FILE is set).");
      mnemonic = "";
    }
  }
  const enabled = flag("CHAIN_ENABLED") && (mnemonic !== "" || session !== undefined);
  if (flag("CHAIN_ENABLED") && !enabled) {
    console.error("CHAIN_ENABLED is set but neither CHAIN_MNEMONIC nor CHAIN_SESSION_KEY_FILE + CHAIN_GRANTER is; running without onchain recording.");
  }
  const publicUrl = (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return { enabled, chain, mnemonic, session, memo: process.env.CHAIN_MEMO ?? "battle-royale", publicUrl };
}
