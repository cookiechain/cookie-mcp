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
  // The codes are IDENTICAL on every deployment. The min-out audit fix APPENDED `SlippageExceeded` to
  // the end of the enum (= 6046) rather than inserting it — lib.rs says so outright: "Appended at the
  // end to keep existing error codes stable (audit: only ever append variants)". Verified against the
  // `#[error_code]` enum in the launchpad source at 8f9c240, 1270e30 and a87a052: 6000–6045 never move.
  //
  // ⚠️ The launchpad's checked-in IDL contradicts its own source, claiming SlippageExceeded == 6019 and
  // shifting the 27 codes after it. MCP used to believe the IDL and shift by +1, which mistranslated
  // every code >= 6019 — e.g. calling "no sale tokens left" a slippage failure. Anchor codes are the
  // compiled enum discriminants, so source wins. These tests pin the SOURCE numbering.
  const DEPLOYMENTS = [
      LAUNCHPAD_PROGRAM_CURRENT,
    "EZWe5C5gV1heTEsaoqh2gVVZQAhrgACSpufPyT9SKruF", // the fee-free clone
    null, // no id available → must not change the answer
  ];

  it("reads the same code the same way on every deployment", () => {
    for (const id of DEPLOYMENTS) {
      expect(launchpadErrorMessage(6000, id)).toContain("paused");
      expect(launchpadErrorMessage(6011, id)).toContain("not in a tradeable state");
      expect(launchpadErrorMessage(6013, id)).toContain("expired");
      expect(launchpadErrorMessage(6017, id)).toContain("raise cap");
      // The range the phantom shift used to corrupt:
      expect(launchpadErrorMessage(6019, id)).toContain("no sale tokens left");
      expect(launchpadErrorMessage(6020, id)).toContain("no bonding-curve");
      expect(launchpadErrorMessage(6021, id)).toContain("sell more shares");
      expect(launchpadErrorMessage(6025, id)).toContain("nothing to claim");
      expect(launchpadErrorMessage(6035, id)).toContain("self-referral");
      expect(launchpadErrorMessage(6040, id)).toContain("anti-snipe");
    }
  });

  // 6039 = GraduationGraceActive, counted off the `#[error_code]` enum in source (Paused = 6000, so the
  // 40th variant is 6039) — the same method that pins 6011/6040/6046/6048, and 6011 is confirmed against
  // the deployed program, which reports it for expire_pool on a settled pool. Audit #1 made the variant
  // unreachable (source: "Retained ONLY to keep error-code numbering stable") without renumbering
  // anything, so it stays mapped — an unexplained code is worse than a retired one — but its text must
  // point at 6048 instead of promising a grace window.
  it("marks 6039 retired rather than promising a grace window that no longer exists", () => {
    expect(launchpadErrorMessage(6039)).toContain("graduation target");
    expect(launchpadErrorMessage(6039)).toContain("retired");
    expect(launchpadErrorMessage(6039)).toContain("6048");
    // Its neighbours are deliberately unmapped; nothing may bleed into them.
    expect(launchpadErrorMessage(6038)).toBeUndefined();
    expect(launchpadErrorMessage(6037)).toBeUndefined();
  });

  // 6048 = PoolMustGraduate, the audit #1 guard that replaced 6039. Counted off the same enum, where it
  // is the 49th variant — appended after SlippageExceeded (6046) and NoPendingAuthority (6047), per the
  // source's "only ever append variants" rule, so nothing before it moved.
  it("explains the graduation-priority refusal at 6048, which only a claim can reach", () => {
    for (const id of DEPLOYMENTS) {
      const msg = launchpadErrorMessage(6048, id);
      expect(msg).toContain("graduate rather than expire");
      // Both bounds matter to the holder: which one applies is the pool's expiry mode.
      expect(msg).toContain("one hour");
      expect(msg).toContain("30 days");
    }
    // 6047 (NoPendingAuthority) is an admin-only code and deliberately unmapped — 6048 must not bleed
    // into it, the way the old IDL-shift bug bled every code into its neighbour.
    expect(launchpadErrorMessage(6047)).toBeUndefined();
    expect(launchpadErrorMessage(6049)).toBeUndefined();
  });

  it("explains slippage at 6046, where the audit fix actually appended it", () => {
    expect(launchpadErrorMessage(6046)).toContain("slippage");
    // 6019 must NOT be slippage — that was the IDL's error, and the bug MCP inherited.
    expect(launchpadErrorMessage(6019)).not.toContain("slippage");
  });

  it("returns undefined for codes it does not explain, rather than a neighbour's message", () => {
    expect(launchpadErrorMessage(6001)).toBeUndefined();
    expect(launchpadErrorMessage(9999)).toBeUndefined();
    // 6018 is ZeroOutput, deliberately unmapped — nothing may pull a neighbour's text into it.
    expect(launchpadErrorMessage(6018)).toBeUndefined();
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
