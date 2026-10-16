import { describe, expect, it } from "vitest";
import { getSigningSparkdreamClientOptions, sparkdream } from "@sparkdreamnft/sparkdreamjs";
import { MSG_EXEC_SESSION, sessionExec } from "./client";

const { registry } = getSigningSparkdreamClientOptions();

const mint = {
  typeUrl: "/sparkdream.artifact.v1.MsgMint",
  value: {
    minter: "sprkdrm1granter",
    classId: BigInt(4),
    entries: [{ recipient: "sprkdrm1ada", metadata: { name: "x", description: "", uri: "", uriHash: "", attributes: [] } }],
    acceptedContentLicense: "CC0-1.0",
  },
};

describe("sessionExec", () => {
  it("wraps the game's messages for the session key to execute as the granter", () => {
    const exec = sessionExec(registry, "sprkdrm1grantee", "sprkdrm1granter", [mint, mint]);
    expect(exec.typeUrl).toBe(MSG_EXEC_SESSION);
    expect(exec.value).toMatchObject({ grantee: "sprkdrm1grantee", granter: "sprkdrm1granter" });
    expect(exec.value.msgs.map((m: { typeUrl: string }) => m.typeUrl)).toEqual([mint.typeUrl, mint.typeUrl]);
    // the inner message round-trips through its Any
    const inner = sparkdream.artifact.v1.MsgMint.decode(exec.value.msgs[0].value);
    expect(inner.minter).toBe("sprkdrm1granter");
    expect(inner.entries[0].recipient).toBe("sprkdrm1ada");
    // and the wrapper itself is encodable by the registry the signing client uses
    expect(registry.encode(exec).length).toBeGreaterThan(0);
  });

  it("keeps to the chain's 1–10 inner messages", () => {
    expect(() => sessionExec(registry, "a", "b", [])).toThrow(/1–10/);
    expect(() => sessionExec(registry, "a", "b", Array(11).fill(mint))).toThrow(/1–10/);
  });
});
