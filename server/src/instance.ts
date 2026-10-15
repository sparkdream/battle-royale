/**
 * Singletons that depend on the chain config but must not import app.ts
 * (app imports GameRoom; a cycle would bite at module-load time).
 */

import { web3 } from "./chain";
import { AddressAuth } from "./auth";

export const addressAuth = new AddressAuth(web3.config.chain.chainId, web3.config.chain.bech32Prefix);
