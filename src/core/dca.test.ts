import { describe, it, expect } from "vitest";
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import dcaIdl from "../idl/dca.json" with { type: "json" };
import { COOK_MINT } from "./config";
import { CookieMcpError } from "./errors";
import {
  DCA_PROGRAM_ID,
  MAX_CYCLES,
  assertCloseTxTrustworthy,
  assertOpenTxTrustworthy,
  cycleCountFor,
  dcaPda,
  dcaReservePda,
  dcaApiError,
  formatSchedule,
  perCycleFor,
  type AggDcaSchedule,
  type ExpectedOpen,
} from "./dca";

const COOK = new PublicKey(COOK_MINT);
const MON = new PublicKey("6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
const coder = new anchorPkg.BorshInstructionCoder(dcaIdl as Idl);

const owner = Keypair.generate();
const base = Keypair.generate();
const ownerCookAta = getAssociatedTokenAddressSync(COOK, owner.publicKey, true);
const ownerMonAta = getAssociatedTokenAddressSync(MON, owner.publicKey, true);

describe("PDAs", () => {
  it("derives the schedule and reserve the way the program does (golden)", () => {
    const b = new PublicKey("B8AB9R9J98yggrwdnZhoHuGJBc8RzTpHsqDnRkTnMuV");
    const dca = dcaPda(b);
    // Any drift in seed strings or program id changes these.
    expect(dca.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("dca"), b.toBuffer()],
        new PublicKey("DCAkvX8FW6zY3kSb8s41QbNk422BttFpoo1v53ywS4Js"),
      )[0].toBase58(),
    );
    expect(dcaReservePda(dca).equals(dca)).toBe(false);
    // The DCA program is NOT the limit-order program: a copy-pasted id would break every check.
    expect(DCA_PROGRAM_ID.toBase58()).toBe("DCAkvX8FW6zY3kSb8s41QbNk422BttFpoo1v53ywS4Js");
  });
});

describe("cycle arithmetic (mirrors the program's derivation)", () => {
  it("cycleCountFor is ceil, like open_dca", () => {
    expect(cycleCountFor(1_000n, 100n)).toBe(10);
    expect(cycleCountFor(1_050n, 100n)).toBe(11);
    expect(cycleCountFor(0n, 100n)).toBe(0);
    expect(cycleCountFor(100n, 0n)).toBe(0);
  });
  it("perCycleFor rounds the slice UP, so the real count can be one lower than asked", () => {
    expect(perCycleFor(10n, 6)).toBe(2n);
    expect(cycleCountFor(10n, perCycleFor(10n, 6)!)).toBe(5);
    expect(perCycleFor(0n, 5)).toBeNull();
    expect(perCycleFor(10n, 0)).toBeNull();
  });
});

describe("formatSchedule", () => {
  const raw: AggDcaSchedule = {
    dca: "dca111",
    user: "user111",
    inputMint: COOK_MINT,
    outputMint: MON.toBase58(),
    inDeposited: "1000000000",
    inUsed: "300000000",
    inRemaining: "700000000",
    outReceived: "600000000",
    inAmountPerCycle: "100000000",
    cycleFrequency: 86_400,
    nextCycleAt: 1_800_086_400,
    cyclesTotal: 10,
    cyclesRemaining: 7,
    spentPct: 30,
    averagePrice: 2,
    minOutAmount: "190000000",
    maxOutAmount: "0",
    minOutAmountNet: "189810000",
    makerFeeBps: 10,
    payoutNative: false,
    refundNative: true,
    waiting: false,
    createdAt: 1_799_000_000,
  };
  const cook = { dec: 9, sym: "COOK" };
  const mon = { dec: 9, sym: "MON" };

  it("renders human amounts, the derived counts and ISO times", () => {
    const v = formatSchedule(raw, cook, mon, 1_800_000_000);
    expect(v.status).toBe("running");
    expect(v.input).toEqual({
      mint: COOK_MINT,
      symbol: "COOK",
      deposited: "1",
      spent: "0.3",
      remaining: "0.7",
    });
    expect(v.output.received).toBe("0.6");
    expect(v.perCycle).toBe("0.1");
    expect(v.cyclesRemaining).toBe(7);
    expect(v.averagePrice).toBe(2);
    expect(v.minPerCycle).toBe("0.19");
    expect(v.minPerCycleNet).toBe("0.18981");
    // An unset band side reads as null, never as "0" — 0 would look like a floor of zero.
    expect(v.maxPerCycle).toBeNull();
    expect(v.nextCycleInSeconds).toBe(86_400);
  });
  it("calls a missed cycle overdue, not a late countdown (it is never caught up)", () => {
    expect(formatSchedule(raw, cook, mon, 1_800_086_401).status).toBe("due");
    expect(formatSchedule(raw, cook, mon, 1_800_090_000).status).toBe("overdue");
    expect(formatSchedule(raw, cook, mon, 1_800_090_000).nextCycleInSeconds).toBeLessThan(0);
    expect(formatSchedule({ ...raw, waiting: true }, cook, mon, 1_800_000_000).status).toBe(
      "filling",
    );
  });
});

// --- Verifier -------------------------------------------------------------------------------------

function openDcaIx(
  over: Partial<{
    inDeposited: bigint;
    perCycle: bigint;
    cycleFrequency: number;
    minOut: bigint;
    maxOut: bigint;
    startAt: number;
    refundNative: boolean;
    user: PublicKey;
    dca: PublicKey;
    userInput: PublicKey;
    userOutput: PublicKey;
    outputMint: PublicKey;
  }> = {},
): TransactionInstruction {
  const dca = over.dca ?? dcaPda(base.publicKey);
  const data = coder.encode("open_dca", {
    in_deposited: new BN((over.inDeposited ?? 1_000_000_000n).toString()),
    in_amount_per_cycle: new BN((over.perCycle ?? 100_000_000n).toString()),
    cycle_frequency: new BN(over.cycleFrequency ?? 86_400),
    min_out_amount: new BN((over.minOut ?? 0n).toString()),
    max_out_amount: new BN((over.maxOut ?? 0n).toString()),
    start_at: new BN(over.startAt ?? 0),
    refund_native: over.refundNative ?? true,
  });
  const k = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: DCA_PROGRAM_ID,
    keys: [
      k(base.publicKey, true),
      k(over.user ?? owner.publicKey, true, true),
      k(dca, false, true),
      k(dcaReservePda(dca), false, true),
      k(over.userInput ?? ownerCookAta, false, true),
      k(over.userOutput ?? ownerMonAta),
      k(COOK),
      k(over.outputMint ?? MON),
      k(TOKEN_PROGRAM_ID),
      k(TOKEN_PROGRAM_ID),
      k(SystemProgram.programId),
    ],
    data,
  });
}

function closeDcaIx(
  over: Partial<{ dca: PublicKey; user: PublicKey; userInput: PublicKey }> = {},
): TransactionInstruction {
  const dca = over.dca ?? dcaPda(base.publicKey);
  const k = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: DCA_PROGRAM_ID,
    keys: [
      k(dca, false, true),
      k(over.user ?? owner.publicKey, true, true),
      k(dcaReservePda(dca), false, true),
      k(over.userInput ?? ownerCookAta, false, true),
      k(COOK),
      k(TOKEN_PROGRAM_ID),
    ],
    data: coder.encode("close_dca", {}),
  });
}

function wrapIxs(amount: number): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      ownerCookAta,
      owner.publicKey,
      COOK,
    ),
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: ownerCookAta,
      lamports: amount,
    }),
    createSyncNativeInstruction(ownerCookAta),
  ];
}

function compile(
  ixs: TransactionInstruction[],
  signers: Keypair[] = [base],
  payer = owner.publicKey,
) {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return tx;
}

const expected: ExpectedOpen = {
  owner: owner.publicKey,
  inputMint: COOK,
  outputMint: MON,
  inDeposited: 1_000_000_000n,
  inAmountPerCycle: 100_000_000n,
  cycleFrequency: 86_400,
  minOut: 0n,
  maxOut: 0n,
  startAt: 0,
  refundNative: true,
  payoutNative: false,
  dca: dcaPda(base.publicKey),
};

const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });

describe("assertOpenTxTrustworthy", () => {
  it("accepts the shape the aggregator builds: CU, wrap the whole budget, create output ATA, open", () => {
    const tx = compile([
      cu,
      ...wrapIxs(1_000_000_000),
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        ownerMonAta,
        owner.publicKey,
        MON,
      ),
      openDcaIx(),
    ]);
    expect(() => assertOpenTxTrustworthy(tx, expected)).not.toThrow();
  });

  it("accepts a band and a future start when they are the ones we asked for", () => {
    const tx = compile([cu, openDcaIx({ minOut: 190_000_000n, startAt: 2_000_000_000 })]);
    expect(() =>
      assertOpenTxTrustworthy(tx, { ...expected, minOut: 190_000_000n, startAt: 2_000_000_000 }),
    ).not.toThrow();
  });

  it("refuses a widened band — the keeper would get room we never granted", () => {
    const tx = compile([cu, openDcaIx({ minOut: 1n })]);
    expect(() => assertOpenTxTrustworthy(tx, { ...expected, minOut: 190_000_000n })).toThrow(
      /minimum output per cycle/,
    );
    const tx2 = compile([cu, openDcaIx({ maxOut: 999n })]);
    expect(() => assertOpenTxTrustworthy(tx2, expected)).toThrow(/maximum output per cycle/);
  });

  it("refuses amounts, frequency and a start time that are not ours", () => {
    expect(() =>
      assertOpenTxTrustworthy(compile([openDcaIx({ inDeposited: 1n })]), expected),
    ).toThrow(/deposited amount/);
    expect(() => assertOpenTxTrustworthy(compile([openDcaIx({ perCycle: 1n })]), expected)).toThrow(
      /amount per cycle/,
    );
    expect(() =>
      assertOpenTxTrustworthy(compile([openDcaIx({ cycleFrequency: 60 })]), expected),
    ).toThrow(/cycle frequency/);
    // A start time we did not ask for is the whole point of the check: the program clamps a past
    // one to "now", so an injected one fires the first cycle immediately.
    expect(() => assertOpenTxTrustworthy(compile([openDcaIx({ startAt: 1 })]), expected)).toThrow(
      /start time/,
    );
  });

  it("refuses another user, another payout account and a flipped refund flag", () => {
    const stranger = Keypair.generate().publicKey;
    expect(() =>
      assertOpenTxTrustworthy(compile([openDcaIx({ user: stranger })]), expected),
    ).toThrow(/user is not our wallet/);
    expect(() =>
      assertOpenTxTrustworthy(compile([openDcaIx({ userOutput: stranger })]), expected),
    ).toThrow(/payout account/);
    expect(() =>
      assertOpenTxTrustworthy(compile([openDcaIx({ refundNative: false })]), expected),
    ).toThrow(/refund flag/);
  });

  it("requires the payout to be OUR wallet when we asked for native COOK out", () => {
    const tx = compile([cu, openDcaIx({ userOutput: owner.publicKey, outputMint: COOK })]);
    // Same-mint pairs never reach here; the point is the pinned-account rule.
    expect(() =>
      assertOpenTxTrustworthy(tx, { ...expected, outputMint: COOK, payoutNative: true }),
    ).not.toThrow();
    expect(() =>
      assertOpenTxTrustworthy(tx, { ...expected, outputMint: COOK, payoutNative: false }),
    ).toThrow(/payout account/);
  });

  it("refuses a schedule address that is not the PDA of the signing base", () => {
    const fake = dcaPda(Keypair.generate().publicKey);
    expect(() => assertOpenTxTrustworthy(compile([openDcaIx({ dca: fake })]), expected)).toThrow(
      /schedule address/,
    );
  });

  it("refuses a fee payer that is not us", () => {
    const stranger = Keypair.generate();
    const tx = compile([openDcaIx()], [base], stranger.publicKey);
    expect(() => assertOpenTxTrustworthy(tx, expected)).toThrow(/fee payer/);
  });

  it("refuses an unsigned base and any extra signer", () => {
    expect(() => assertOpenTxTrustworthy(compile([openDcaIx()], []), expected)).toThrow(
      /has not pre-signed/,
    );
    const extra = Keypair.generate();
    const ix = openDcaIx();
    ix.keys.push({ pubkey: extra.publicKey, isSigner: true, isWritable: false });
    expect(() => assertOpenTxTrustworthy(compile([ix], [base, extra]), expected)).toThrow(
      /extra signer/,
    );
  });

  it("refuses two program instructions, or a different one", () => {
    expect(() => assertOpenTxTrustworthy(compile([openDcaIx(), openDcaIx()]), expected)).toThrow(
      /2 DCA instructions/,
    );
    expect(() => assertOpenTxTrustworthy(compile([closeDcaIx()], []), expected)).toThrow(
      /program instruction close_dca/,
    );
  });

  it("refuses an unknown program, a lamport transfer out and an ATA create for someone else", () => {
    const stranger = Keypair.generate().publicKey;
    const alien = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.alloc(0),
    });
    expect(() => assertOpenTxTrustworthy(compile([alien, openDcaIx()]), expected)).toThrow(
      /unexpected program/,
    );
    const drain = SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: stranger,
      lamports: 1,
    });
    expect(() => assertOpenTxTrustworthy(compile([drain, openDcaIx()]), expected)).toThrow(
      /lamport transfer/,
    );
    const foreignAta = createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      getAssociatedTokenAddressSync(MON, stranger, true),
      stranger,
      MON,
    );
    expect(() => assertOpenTxTrustworthy(compile([foreignAta, openDcaIx()]), expected)).toThrow(
      /another wallet/,
    );
  });

  it("refuses an address lookup table (accounts we cannot see)", () => {
    const msg = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [cu, openDcaIx()],
    }).compileToV0Message([
      {
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: 0n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: [TOKEN_PROGRAM_ID, SystemProgram.programId],
        },
      },
    ]);
    const tx = new VersionedTransaction(msg);
    tx.sign([base]);
    expect(() => assertOpenTxTrustworthy(tx, expected)).toThrow(/address lookup table/);
  });
});

describe("assertCloseTxTrustworthy", () => {
  const exp = {
    owner: owner.publicKey,
    dca: dcaPda(base.publicKey),
    inputMint: COOK,
    refundNative: false,
  };

  it("accepts the wCOOK shape: recreate the ATA, close, unwrap fully to us", () => {
    const tx = compile(
      [
        cu,
        createAssociatedTokenAccountIdempotentInstruction(
          owner.publicKey,
          ownerCookAta,
          owner.publicKey,
          COOK,
        ),
        closeDcaIx(),
        createCloseAccountInstruction(ownerCookAta, owner.publicKey, owner.publicKey),
      ],
      [],
    );
    expect(() => assertCloseTxTrustworthy(tx, exp)).not.toThrow();
  });

  it("accepts a partial unwrap through a pre-signed temp that closes to us", () => {
    const temp = Keypair.generate();
    const rent = 2_039_280;
    const tx = compile(
      [
        closeDcaIx(),
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: temp.publicKey,
          lamports: rent,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
        createTransferInstruction(ownerCookAta, temp.publicKey, owner.publicKey, 1_000),
        createCloseAccountInstruction(temp.publicKey, owner.publicKey, owner.publicKey),
      ],
      [temp],
    );
    expect(() => assertCloseTxTrustworthy(tx, exp)).not.toThrow();
  });

  it("accepts a native-refund schedule paying our wallet directly", () => {
    const tx = compile([closeDcaIx({ userInput: owner.publicKey })], []);
    expect(() => assertCloseTxTrustworthy(tx, { ...exp, refundNative: true })).not.toThrow();
    // …and refuses that same build when the schedule was NOT native-refund.
    expect(() => assertCloseTxTrustworthy(tx, exp)).toThrow(/refund account is not ours/);
  });

  it("refuses a refund to a stranger, another wallet's schedule and the wrong schedule", () => {
    const stranger = Keypair.generate().publicKey;
    expect(() =>
      assertCloseTxTrustworthy(
        compile(
          [closeDcaIx({ userInput: getAssociatedTokenAddressSync(COOK, stranger, true) })],
          [],
        ),
        exp,
      ),
    ).toThrow(/refund account is not ours/);
    expect(() =>
      assertCloseTxTrustworthy(compile([closeDcaIx({ user: stranger })], []), exp),
    ).toThrow(/user is not our wallet/);
    expect(() =>
      assertCloseTxTrustworthy(compile([closeDcaIx()], []), {
        ...exp,
        dca: dcaPda(Keypair.generate().publicKey),
      }),
    ).toThrow(/schedule address/);
  });

  it("refuses a token transfer to an account that is not ours", () => {
    const stranger = Keypair.generate().publicKey;
    const tx = compile(
      [closeDcaIx(), createTransferInstruction(ownerCookAta, stranger, owner.publicKey, 1_000)],
      [],
    );
    expect(() => assertCloseTxTrustworthy(tx, exp)).toThrow(/not ours/);
  });
});

describe("dcaApiError", () => {
  it("names the DCA-specific refusals with what to do instead", () => {
    const cases: [string, RegExp][] = [
      ["DCA schedules are disabled", /not switched on yet/],
      ["DCA is not available on Token-2022 mints yet (X)", /Token-2022/],
      ["DCA is not available on MomoSwap bonding-curve tokens (X)", /bonding-curve/],
      ["not a mint: X", /not a token mint/],
      ["schedule not found (already finished or closed?)", /finished/],
      ["owner is not the user of this schedule", /another wallet/],
    ];
    for (const [msg, re] of cases) {
      const e = dcaApiError(new Error(msg), "opening the schedule");
      expect(e).toBeInstanceOf(CookieMcpError);
      expect(`${e.message} ${e.hint ?? ""}`).toMatch(re);
    }
  });
  it("falls through to the shared aggregator hints", () => {
    expect(dcaApiError(new Error("AccountNotFound"), "opening the schedule").message).toMatch(
      /no COOK on chain/,
    );
  });
});

describe("guard rails that are constants, not code", () => {
  it("pins the program's cycle cap", () => {
    expect(MAX_CYCLES).toBe(1024);
  });
});
