import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { parseClaimMint, isCreator, hasClaimableFees, formatClaimed } from "./creatorFees";
import { CookieMcpError } from "../errors";

describe("parseClaimMint", () => {
  it("parses a valid mint", () => {
    const m = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";
    expect(parseClaimMint(m).toBase58()).toBe(m);
  });

  it("throws with a deploy_token hint on a bad mint", () => {
    try {
      parseClaimMint("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CookieMcpError);
      expect((e as CookieMcpError).hint).toMatch(/deploy_token/);
    }
  });
});

describe("isCreator", () => {
  it("is true only for the exact creator key", () => {
    const creator = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    expect(isCreator(creator, new PublicKey(creator.toBytes()))).toBe(true);
    expect(isCreator(creator, other)).toBe(false);
  });
});

describe("hasClaimableFees", () => {
  it("is false only when both sides are zero", () => {
    expect(hasClaimableFees(new BN(0), new BN(0))).toBe(false);
    expect(hasClaimableFees(new BN(1), new BN(0))).toBe(true);
    expect(hasClaimableFees(new BN(0), new BN(1))).toBe(true);
    expect(hasClaimableFees(new BN(5), new BN(7))).toBe(true);
  });
});

describe("formatClaimed", () => {
  it("formats base in DBC token decimals (6) and quote in COOK decimals (9)", () => {
    const out = formatClaimed(new BN(1_500_000), new BN(2_000_000_000));
    expect(out.base).toBe("1.5"); // 1_500_000 @ 6 decimals
    expect(out.quote).toBe("2"); // 2_000_000_000 @ 9 decimals
  });
});
