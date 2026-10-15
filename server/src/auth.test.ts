import { describe, expect, it } from "vitest";
import { Secp256k1HdWallet, makeSignDoc } from "@cosmjs/amino";
import { toBase64 } from "@cosmjs/encoding";
import { AddressAuth } from "./auth";

const CHAIN_ID = "sparkdream-dev-1";
const PREFIX = "sprkdrm";

/** Flip one base64 character in the middle (length and padding untouched). */
function flipMiddle(b64: string): string {
  const i = Math.floor(b64.length / 2);
  const c = b64[i] === "A" ? "B" : "A";
  return b64.slice(0, i) + c + b64.slice(i + 1);
}

/** Keplr's signArbitrary is an amino StdSignDoc; cosmjs signs the same bytes. */
async function signNonce(wallet: Secp256k1HdWallet, address: string, nonce: string, chainId = CHAIN_ID) {
  const doc = makeSignDoc([], { amount: [], gas: "0" }, chainId, nonce, 0, 0);
  const signed = await wallet.signAmino(address, doc);
  return signed.signature.signature;
}

async function account() {
  const wallet = await Secp256k1HdWallet.generate(12, { prefix: PREFIX });
  const [{ address, pubkey }] = await wallet.getAccounts();
  return { wallet, address, pubKey: toBase64(pubkey) };
}

describe("AddressAuth", () => {
  it("accepts a genuine Keplr-style signature and hands out a ticket for the address", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address, pubKey } = await account();

    const nonce = auth.issueNonce(address);
    const signature = await signNonce(wallet, address, nonce);
    const ticket = auth.verify({ address, pubKey, signature, nonce });

    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.addressFor(ticket)).toBe(address);
    // The address itself is public and never a credential.
    expect(auth.addressFor(address)).toBeUndefined();
    expect(auth.addressFor(undefined)).toBeUndefined();
    expect(auth.addressFor("0".repeat(64))).toBeUndefined();
  });

  it("rejects a tampered signature", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address, pubKey } = await account();
    const nonce = auth.issueNonce(address);
    const signature = await signNonce(wallet, address, nonce);
    const flipped = flipMiddle(signature);
    expect(() => auth.verify({ address, pubKey, signature: flipped, nonce })).toThrow(/signature/i);
  });

  it("rejects a nonce signed for a different chain", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address, pubKey } = await account();
    const nonce = auth.issueNonce(address);
    const signature = await signNonce(wallet, address, nonce, "sparkdream-other-1");
    expect(() => auth.verify({ address, pubKey, signature, nonce })).toThrow();
  });

  it("each nonce works exactly once, and unknown nonces are rejected", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address, pubKey } = await account();
    const nonce = auth.issueNonce(address);
    const signature = await signNonce(wallet, address, nonce);
    auth.verify({ address, pubKey, signature, nonce });
    expect(() => auth.verify({ address, pubKey, signature, nonce })).toThrow(/nonce/i);
  });

  it("keeps a few nonces open per address, so a second tab does not break the first", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address, pubKey } = await account();
    const first = auth.issueNonce(address);
    const second = auth.issueNonce(address);
    const sigFirst = await signNonce(wallet, address, first);
    expect(auth.addressFor(auth.verify({ address, pubKey, signature: sigFirst, nonce: first }))).toBe(address);
    const sigSecond = await signNonce(wallet, address, second);
    expect(auth.addressFor(auth.verify({ address, pubKey, signature: sigSecond, nonce: second }))).toBe(address);
    // Past the cap the oldest is dropped, never the newest.
    const a = auth.issueNonce(address);
    auth.issueNonce(address);
    auth.issueNonce(address);
    const d = auth.issueNonce(address);
    expect(() => auth.verify({ address, pubKey, signature: "", nonce: a })).toThrow(/nonce/i);
    expect(() => auth.verify({ address, pubKey, signature: "", nonce: d })).toThrow(/pubkey|signature/i);
  });

  it("rejects a pubkey that does not derive the address", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    const { wallet, address } = await account();
    const other = await account();
    const nonce = auth.issueNonce(address);
    const signature = await signNonce(wallet, address, nonce);
    expect(() => auth.verify({ address, pubKey: other.pubKey, signature, nonce })).toThrow(/pubkey/i);
  });

  it("refuses nonces for addresses that are not bech32 with our prefix", async () => {
    const auth = new AddressAuth(CHAIN_ID, PREFIX);
    expect(() => auth.issueNonce("cosmos1abc")).toThrow(/address/i);
    expect(() => auth.issueNonce("")).toThrow(/address/i);
    // Right prefix, bad checksum: not just a string prefix test.
    const { address } = await account();
    expect(() => auth.issueNonce(address.slice(0, -1) + (address.endsWith("a") ? "b" : "a"))).toThrow(/address/i);
  });
});
