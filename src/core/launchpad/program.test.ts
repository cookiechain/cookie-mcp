import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

import {
  launchpadErrorMessage,
  launchpadProgramIdFromTx,
  LAUNCHPAD_PROGRAM_CURRENT,
  LAUNCHPAD_PROGRAM_PRE_SLIPPAGE,
} from "./program";

const CU_PROGRAM = "ComputeBudget111111111111111111111111111111";

function ix(programId: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [],
    data: Buffer.alloc(0),
  });
}

describe("launchpadErrorMessage", () => {
  // The audit fix that added buy_v2/sell_v2 INSERTED SlippageExceeded at 6019, so every code from
  // there up means something different depending on which deployment threw it. Getting this wrong
  // hands an agent a confident, wrong explanation — worse than no translation at all.
  it("reads the pre-slippage build's codes as they were", () => {
    expect(launchpadErrorMessage(6019, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE)).toContain(
      "no sale tokens left",
    );
    expect(launchpadErrorMessage(6020, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE)).toContain(
      "no bonding-curve",
    );
    expect(launchpadErrorMessage(6025, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE)).toContain(
      "nothing to claim",
    );
    expect(launchpadErrorMessage(6035, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE)).toContain("self-referral");
    expect(launchpadErrorMessage(6040, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE)).toContain("anti-snipe");
  });

  it("shifts every code >= 6019 by one on a post-audit build, and explains 6019 as slippage", () => {
    expect(launchpadErrorMessage(6019, LAUNCHPAD_PROGRAM_CURRENT)).toContain("slippage");
    expect(launchpadErrorMessage(6020, LAUNCHPAD_PROGRAM_CURRENT)).toContain("no sale tokens left");
    expect(launchpadErrorMessage(6021, LAUNCHPAD_PROGRAM_CURRENT)).toContain("no bonding-curve");
    expect(launchpadErrorMessage(6022, LAUNCHPAD_PROGRAM_CURRENT)).toContain("sell more shares");
    expect(launchpadErrorMessage(6026, LAUNCHPAD_PROGRAM_CURRENT)).toContain("nothing to claim");
    expect(launchpadErrorMessage(6027, LAUNCHPAD_PROGRAM_CURRENT)).toContain(
      "already been claimed",
    );
    expect(launchpadErrorMessage(6036, LAUNCHPAD_PROGRAM_CURRENT)).toContain("self-referral");
    expect(launchpadErrorMessage(6041, LAUNCHPAD_PROGRAM_CURRENT)).toContain("anti-snipe");
  });

  it("leaves the codes below the insertion point alone in both builds", () => {
    for (const id of [LAUNCHPAD_PROGRAM_PRE_SLIPPAGE, LAUNCHPAD_PROGRAM_CURRENT]) {
      expect(launchpadErrorMessage(6000, id)).toContain("paused");
      expect(launchpadErrorMessage(6011, id)).toContain("not in a tradeable state");
      expect(launchpadErrorMessage(6013, id)).toContain("expired");
      expect(launchpadErrorMessage(6017, id)).toContain("raise cap");
    }
  });

  it("treats an unknown deployment as a current build (the program only moves forward)", () => {
    expect(launchpadErrorMessage(6019, "EZWe5C5gV1heTEsaoqh2gVVZQAhrgACSpufPyT9SKruF")).toContain(
      "slippage",
    );
  });

  it("returns undefined for codes it does not explain, rather than a neighbour's message", () => {
    expect(launchpadErrorMessage(6001, LAUNCHPAD_PROGRAM_CURRENT)).toBeUndefined();
    expect(launchpadErrorMessage(9999, LAUNCHPAD_PROGRAM_CURRENT)).toBeUndefined();
    // 6018 (ZeroOutput) is unmapped in both builds — the shift must not pull 6019's text down to it.
    expect(launchpadErrorMessage(6018, LAUNCHPAD_PROGRAM_CURRENT)).toBeUndefined();
  });
});

describe("launchpadProgramIdFromTx", () => {
  it("picks the launchpad out of an API-built transaction full of ambient programs", () => {
    const tx = new Transaction().add(
      ix(CU_PROGRAM),
      SystemProgram.transfer({
        fromPubkey: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT),
        toPubkey: new PublicKey(LAUNCHPAD_PROGRAM_CURRENT),
        lamports: 1,
      }),
      ix("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      ix(LAUNCHPAD_PROGRAM_CURRENT),
    );
    expect(launchpadProgramIdFromTx(tx)).toBe(LAUNCHPAD_PROGRAM_CURRENT);
  });

  it("works for the old deployment too", () => {
    const tx = new Transaction().add(ix(CU_PROGRAM), ix(LAUNCHPAD_PROGRAM_PRE_SLIPPAGE));
    expect(launchpadProgramIdFromTx(tx)).toBe(LAUNCHPAD_PROGRAM_PRE_SLIPPAGE);
  });

  it("returns null when it cannot tell, instead of guessing wrong", () => {
    // Two unknown programs: no basis to pick one, so the caller falls back to the configured id.
    const ambiguous = new Transaction().add(
      ix(LAUNCHPAD_PROGRAM_CURRENT),
      ix(LAUNCHPAD_PROGRAM_PRE_SLIPPAGE),
    );
    expect(launchpadProgramIdFromTx(ambiguous)).toBeNull();
    expect(launchpadProgramIdFromTx(new Transaction().add(ix(CU_PROGRAM)))).toBeNull();
    expect(launchpadProgramIdFromTx(new Transaction())).toBeNull();
  });
});
