/**
 * Address ownership proofs: the client asks for a nonce, has Keplr sign it
 * (signArbitrary, an amino StdSignDoc with the nonce as memo), and posts the
 * signature back. A successful proof returns a secret ticket; the client
 * sends that ticket as JoinOptions.ticket, which is what ties match results
 * to an onchain identity. The address itself is public (leaderboard), so
 * it can never be the credential.
 */

import { randomBytes } from "node:crypto";
import { makeSignDoc, rawSecp256k1PubkeyToRawAddress, serializeSignDoc } from "@cosmjs/amino";
import { Secp256k1, Secp256k1Signature, Sha256 } from "@cosmjs/crypto";
import { fromBase64, fromBech32, toBech32 } from "@cosmjs/encoding";

const NONCE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 15 * 60_000;
/** Open nonces per address (several tabs may each ask for one). */
const MAX_NONCES_PER_ADDRESS = 3;
/** Addresses with open nonces at once; past it, new requests are refused until some expire. */
const MAX_PENDING_ADDRESSES = 10_000;

export interface VerifyRequest {
  address: string;
  /** Compressed secp256k1 pubkey, base64 (Keplr getKey().pubKey). */
  pubKey: string;
  /** Signature over the nonce sign doc, base64 (Keplr signArbitrary). */
  signature: string;
  nonce: string;
}

export class AddressAuth {
  private nonces = new Map<string, { nonce: string; expires: number }[]>();
  private tickets = new Map<string, { address: string; expires: number }>();

  constructor(
    private readonly chainId: string,
    private readonly prefix: string,
  ) {}

  issueNonce(address: string): string {
    if (!this.validAddress(address)) throw new Error("not a valid address");
    this.prune();
    const pending = this.nonces.get(address) ?? [];
    if (pending.length === 0 && this.nonces.size >= MAX_PENDING_ADDRESSES) throw new Error("too many pending nonces");
    const nonce = randomBytes(16).toString("hex");
    pending.push({ nonce, expires: Date.now() + NONCE_TTL_MS });
    // Oldest out past the cap: a retry never locks the address out.
    this.nonces.set(address, pending.slice(-MAX_NONCES_PER_ADDRESS));
    return nonce;
  }

  /** Check the proof. Returns the ticket that stands for the address for a while. */
  verify(req: VerifyRequest): string {
    const address = typeof req.address === "string" ? req.address : "";
    const pending = this.nonces.get(address) ?? [];
    const match = pending.find((n) => n.nonce === req.nonce && Date.now() <= n.expires);
    if (!match) throw new Error("unknown or expired nonce");
    const pubkey = fromBase64(req.pubKey);
    if (pubkey.length !== 33) throw new Error("expected a 33-byte compressed pubkey");
    const derived = toBech32(this.prefix, rawSecp256k1PubkeyToRawAddress(pubkey));
    if (derived !== address) throw new Error("pubkey does not match the address");

    // Exactly the doc Keplr's signArbitrary signs: empty amino tx, nonce as memo.
    const doc = makeSignDoc(
      [],
      { amount: [], gas: "0" },
      this.chainId,
      match.nonce,
      0,
      0,
    );
    let ok = false;
    try {
      let sigBytes = fromBase64(req.signature);
      if (sigBytes.length === 65) sigBytes = sigBytes.subarray(1); // strip recovery byte
      ok = Secp256k1.verifySignature(
        Secp256k1Signature.fromFixedLength(sigBytes),
        new Sha256(serializeSignDoc(doc)).digest(),
        pubkey,
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("bad signature");

    // Each nonce works once; the address's other open nonces stay usable.
    const rest = pending.filter((n) => n !== match);
    if (rest.length > 0) this.nonces.set(address, rest);
    else this.nonces.delete(address);
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, { address, expires: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** The address a ticket stands for, while it is fresh (JoinOptions gate). */
  addressFor(ticket: unknown): string | undefined {
    if (typeof ticket !== "string") return undefined;
    const entry = this.tickets.get(ticket);
    if (!entry || Date.now() > entry.expires) return undefined;
    return entry.address;
  }

  private validAddress(address: unknown): address is string {
    if (typeof address !== "string" || address.length > 100) return false;
    try {
      return fromBech32(address, 90).prefix === this.prefix;
    } catch {
      return false;
    }
  }

  private prune() {
    const now = Date.now();
    for (const [address, list] of this.nonces) {
      const live = list.filter((n) => n.expires > now);
      if (live.length === 0) this.nonces.delete(address);
      else if (live.length !== list.length) this.nonces.set(address, live);
    }
    for (const [ticket, entry] of this.tickets) if (entry.expires <= now) this.tickets.delete(ticket);
  }
}
