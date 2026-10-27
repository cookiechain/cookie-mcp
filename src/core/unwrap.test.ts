import {
  ACCOUNT_SIZE,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { unwrapPlan } from "./unwrap";

const RENT = 2_039_280n;

function wcookAccount(owner: PublicKey, amount: bigint, mint = NATIVE_MINT): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: RENT,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    executable: false,
    lamports: Number(RENT + amount),
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  };
}

describe("unwrapPlan", () => {
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);

  it("returns the wrapped balance and the account's rent separately", () => {
    expect(unwrapPlan(owner, ata, wcookAccount(owner, 1_500_000_000n))).toEqual({
      wrapped: 1_500_000_000n,
      rent: RENT,
    });
  });

  it("still closes an empty account for its rent", () => {
    expect(unwrapPlan(owner, ata, wcookAccount(owner, 0n))).toEqual({ wrapped: 0n, rent: RENT });
  });

  it("refuses when the wallet has no wCOOK account", () => {
    expect(() => unwrapPlan(owner, ata, null)).toThrow(/holds no wrapped COOK/);
  });

  it("refuses an account that is not this wallet's wCOOK", () => {
    const stranger = Keypair.generate().publicKey;
    expect(() => unwrapPlan(owner, ata, wcookAccount(stranger, 1n))).toThrow(/does not hold/);
    const otherMint = Keypair.generate().publicKey;
    expect(() => unwrapPlan(owner, ata, wcookAccount(owner, 1n, otherMint))).toThrow(
      /does not hold/,
    );
  });
});
