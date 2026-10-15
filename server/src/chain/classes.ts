/**
 * The game's three x/artifact classes, created once per relayer account
 * (idempotently, at boot). Class ids resolve by symbol among the classes the
 * relayer owns, so a second deployment with a different key mints its own.
 */

import type { EncodeObject } from "@cosmjs/proto-signing";

export type ClassKey = "career" | "badge" | "map" | "match";
export type ClassIds = Record<ClassKey, string>;

export const CLASS_SPECS: readonly { key: ClassKey; symbol: string; name: string; description: string; transferable: boolean }[] = [
  {
    key: "career",
    symbol: "BRCAREER",
    name: "Battle Royale Career",
    description: "One soulbound token per linked player carrying their lifetime record: matches, wins, kills, damage, collected items, maps and achievements.",
    transferable: false,
  },
  {
    key: "badge",
    symbol: "BRBADGE",
    name: "Battle Royale Badges",
    description: "Soulbound achievement badges minted to players as they unlock them.",
    transferable: false,
  },
  {
    key: "map",
    symbol: "BRMAP",
    name: "Battle Royale Maps",
    description: "Collectible map tokens, one per match, minted to the winner with the layout's seed so anyone can verify the ground it was won on.",
    transferable: true,
  },
  {
    key: "match",
    symbol: "BRMATCH",
    name: "Battle Royale Matches",
    description: "One record per finished match with linked players, held by the game's relayer: map, winner and the sha256 of the full result served at the token's uri.",
    transferable: false,
  },
];

/** BURN_AUTHORIZATION_HOLDER: the default, and the only kind that never needs the recipient's consent. */
const BURN_HOLDER = 0;

export function createClassMsg(creator: string, spec: (typeof CLASS_SPECS)[number], denom: string): EncodeObject {
  return {
    typeUrl: "/sparkdream.artifact.v1.MsgCreateClass",
    value: {
      creator,
      name: spec.name,
      symbol: spec.symbol,
      description: spec.description,
      uri: "",
      uriHash: "",
      tokenUriBase: "",
      flags: { transferable: spec.transferable, burnAuthorization: BURN_HOLDER, tokenMetadataMutable: true },
      maxSupply: BigInt(0),
      mintPolicy: {
        publicMintEnabled: false,
        price: { denom, amount: "0" },
        startTime: BigInt(0),
        endTime: BigInt(0),
        perAddressLimit: 0,
      },
      payoutAddress: "",
      royaltyBps: 0,
      royaltyRecipients: [],
      minters: [],
      acceptedContentLicense: "CC0-1.0",
    },
  };
}
