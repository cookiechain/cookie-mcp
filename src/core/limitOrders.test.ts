import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
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

import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import { COOK_MINT } from "./config";
import { CookieMcpError } from "./errors";
import {
  ALLOWED_PROGRAMS,
  LIMIT_ORDER_PROGRAM_ID,
  ORDER_KIND_LIMIT,
  ORDER_KIND_STOP,
  assertCancelTxTrustworthy,
  assertPlaceTxTrustworthy,
  expiryFromSeconds,
  fillsImmediately,
  formatLimitOrder,
  decodeSaleAuth,
  buildRevokePositionSaleIx,
  SALE_AUTH_DISCRIMINATOR,
  REVOKE_POSITION_SALE_DISCRIMINATOR,
  SALE_AUTH_SIZE,
  makerNetOut,
  normalizePrice,
  orderPda,
  pctFromMarket,
  priceFromAmounts,
  reservePda,
  takingAmountForPrice,
  type AggLimitOrder,
  type ExpectedPlace,
} from "./limitOrders";

const COOK = new PublicKey(COOK_MINT);
const MON = new PublicKey("6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
const coder = new anchorPkg.BorshInstructionCoder(limitOrderIdl as Idl);

describe("PDAs", () => {
  it("derives the order and reserve the way the program does (golden)", () => {
    const base = new PublicKey("B8AB9R9J98yggrwdnZhoHuGJBc8RzTpHsqDnRkTnMuV");
    const order = orderPda(base);
    // Any drift in seed strings or program id changes these.
    expect(order.toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("order"), base.toBuffer()],
        new PublicKey("L1M1tkE57jpgimzjs5S8HVsmwk4uwrWoDFuUvXpVniH"),
      )[0].toBase58(),
    );
    expect(reservePda(order).equals(reservePda(order))).toBe(true);
    expect(reservePda(order).equals(order)).toBe(false);
  });
});

describe("takingAmountForPrice (mirrors the API's exact math)", () => {
  it("converts at equal and differing decimals", () => {
    expect(takingAmountForPrice(1_000_000n, "2", 6, 6)).toBe(2_000_000n);
    expect(takingAmountForPrice(1_000_000n, "2", 6, 9)).toBe(2_000_000_000n);
  });
  it("is exact where a float would not be", () => {
    expect(takingAmountForPrice(3_000_000n, "0.1", 6, 6)).toBe(300_000n);
  });
  it("rounds UP so the maker never asks for less than the price set", () => {
    expect(takingAmountForPrice(3n, "0.5", 0, 0)).toBe(2n);
  });
  it("rejects zero / junk", () => {
    expect(takingAmountForPrice(1_000n, "0", 6, 6)).toBeNull();
    expect(takingAmountForPrice(1_000n, "", 6, 6)).toBeNull();
    expect(takingAmountForPrice(0n, "1", 6, 6)).toBeNull();
  });
  it("round-trips through priceFromAmounts", () => {
    const taking = takingAmountForPrice(1_000_000n, "1.5", 6, 6)!;
    expect(priceFromAmounts(1_000_000n, taking, 6, 6)).toBeCloseTo(1.5, 9);
  });
});

describe("fees and market helpers", () => {
  it("makerNetOut rounds the fee down like the program", () => {
    expect(makerNetOut(1_000_000n, 10)).toBe(999_000n);
    expect(makerNetOut(999n, 10)).toBe(999n);
  });
  it("pctFromMarket signs premium vs discount and refuses a bad market", () => {
    expect(pctFromMarket(1.1, 1)).toBeCloseTo(10);
    expect(pctFromMarket(0.9, 1)).toBeCloseTo(-10);
    expect(pctFromMarket(1, 0)).toBeNull();
  });
  it("fillsImmediately: a TP at/below market, a stop at/above market", () => {
    expect(fillsImmediately("limit", 100n, 100n)).toBe(true);
    expect(fillsImmediately("limit", 101n, 100n)).toBe(false);
    expect(fillsImmediately("stop", 100n, 100n)).toBe(true);
    expect(fillsImmediately("stop", 99n, 100n)).toBe(false);
  });
});

describe("normalizePrice", () => {
  it("passes decimal strings and plain numbers through", () => {
    expect(normalizePrice("0.75")).toBe("0.75");
    expect(normalizePrice(0.75)).toBe("0.75");
    expect(normalizePrice(" 12 ")).toBe("12");
  });
  it("refuses exponent-form numbers, zero and junk", () => {
    expect(() => normalizePrice(1e-9)).toThrow(CookieMcpError);
    expect(() => normalizePrice(0)).toThrow(CookieMcpError);
    expect(() => normalizePrice("abc")).toThrow(CookieMcpError);
    expect(() => normalizePrice("-1")).toThrow(CookieMcpError);
  });
});

describe("expiryFromSeconds", () => {
  it("defaults to a week, 0 = never, caps at a year", () => {
    expect(expiryFromSeconds(undefined, 1_000)).toBe(1_000 + 7 * 86_400);
    expect(expiryFromSeconds(0, 1_000)).toBeNull();
    expect(expiryFromSeconds(3_600, 1_000)).toBe(4_600);
    expect(() => expiryFromSeconds(366 * 86_400, 1_000)).toThrow(/year/);
    expect(() => expiryFromSeconds(-1, 1_000)).toThrow(CookieMcpError);
  });
});

describe("formatLimitOrder", () => {
  const raw: AggLimitOrder = {
    order: "order111",
    maker: "maker111",
    inputMint: COOK_MINT,
    outputMint: MON.toBase58(),
    makingAmount: "900000000",
    takingAmount: "675000000",
    netTakingAmount: "674325000",
    makerFeeBps: 10,
    oriMakingAmount: "1000000000",
    oriTakingAmount: "750000000",
    filledPct: 10,
    price: 0.75,
    kind: "limit",
    triggerTakingAmount: null,
    floorPrice: null,
    expiredAt: 1_760_000_000,
    createdAt: 1_757_700_000,
    payoutNative: false,
    refundNative: true,
    waiting: false,
  };
  const cook = { dec: 9, sym: "COOK", priceCook: 1 };
  const mon = { dec: 9, sym: "MON", priceCook: null };

  it("renders human amounts, status and ISO times", () => {
    const v = formatLimitOrder(raw, cook, mon, 1_759_000_000);
    expect(v.status).toBe("open");
    expect(v.input).toEqual({ mint: COOK_MINT, symbol: "COOK", remaining: "0.9", original: "1" });
    expect(v.output.minReceive).toBe("0.675");
    expect(v.output.netAfterFee).toBe("0.674325");
    expect(v.expiresAt).toBe("2025-10-09T08:53:20.000Z");
    expect(v.floorPrice).toBeNull();
  });
  it("flags an expired order and a fill in flight", () => {
    expect(formatLimitOrder(raw, cook, mon, 1_760_000_001).status).toBe("expired");
    expect(formatLimitOrder({ ...raw, waiting: true }, cook, mon, 1_759_000_000).status).toBe(
      "filling",
    );
  });
  it("keeps a stop's floor price", () => {
    const v = formatLimitOrder({ ...raw, kind: "stop", floorPrice: 0.375 }, cook, mon, 0);
    expect(v.floorPrice).toBe(0.375);
  });
  it("a plain order is escrowed and has no curve pool", () => {
    const v = formatLimitOrder(raw, cook, mon, 1_759_000_000);
    expect(v.escrowed).toBe(true);
    expect(v.curvePool).toBeNull();
    expect(v.createdAt).toBe("2025-09-12T18:00:00.000Z");
  });
  it("a curve buy is an escrow order that names its pool", () => {
    const v = formatLimitOrder(
      { ...raw, kind: "curve-buy", curvePool: "pool111" },
      cook,
      mon,
      1_759_000_000,
    );
    expect(v.kind).toBe("curve-buy");
    expect(v.curvePool).toBe("pool111");
    expect(v.escrowed).toBe(true);
  });
  it("a curve sell is not escrowed and has no creation time (not 1970)", () => {
    const v = formatLimitOrder(
      { ...raw, kind: "curve-sell", curvePool: "pool111", createdAt: null, escrowed: false },
      mon,
      cook,
      1_759_000_000,
    );
    expect(v.kind).toBe("curve-sell");
    expect(v.escrowed).toBe(false);
    expect(v.createdAt).toBeNull();
    expect(v.status).toBe("open");
  });
});

// --- Curve sells: SaleAuthorization decode + revoke ix ----------------------------------------------

describe("curve-sell revoke", () => {
  const pool = Keypair.generate().publicKey;
  const ownerPk = Keypair.generate().publicKey;
  const delegate = Keypair.generate().publicKey;
  const payout = Keypair.generate().publicKey;
  const saleAuthBytes = (over: { disc?: number[]; size?: number } = {}) => {
    const b = Buffer.alloc(SALE_AUTH_SIZE);
    Buffer.from(over.disc ?? SALE_AUTH_DISCRIMINATOR).copy(b, 0);
    pool.toBuffer().copy(b, 8);
    ownerPk.toBuffer().copy(b, 40);
    delegate.toBuffer().copy(b, 72);
    payout.toBuffer().copy(b, 104);
    b.writeBigUInt64LE(22_580_000_000n, 136); // approved
    b.writeBigUInt64LE(12_340_000_000n, 144); // remaining
    return over.size === undefined ? b : b.subarray(0, over.size);
  };
  it("discriminators are the anchor sighashes", () => {
    const sighash = (s: string) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
    expect([...SALE_AUTH_DISCRIMINATOR]).toEqual(sighash("account:SaleAuthorization"));
    expect([...REVOKE_POSITION_SALE_DISCRIMINATOR]).toEqual(sighash("global:revoke_position_sale"));
  });
  it("decodes pool, owner, delegate, payout and the remaining shares", () => {
    const a = decodeSaleAuth(saleAuthBytes())!;
    expect(a.pool.equals(pool)).toBe(true);
    expect(a.owner.equals(ownerPk)).toBe(true);
    expect(a.delegate.equals(delegate)).toBe(true);
    expect(a.payoutAccount.equals(payout)).toBe(true);
    expect(a.remainingShares).toBe(12_340_000_000n);
  });
  it("rejects a wrong discriminator and a short account", () => {
    expect(decodeSaleAuth(saleAuthBytes({ disc: [1, 2, 3, 4, 5, 6, 7, 8] }))).toBeNull();
    expect(decodeSaleAuth(saleAuthBytes({ size: 100 }))).toBeNull();
  });
  it("revoke ix: owner signs, the authorization is writable, data is the bare discriminator", () => {
    const programId = Keypair.generate().publicKey;
    const saleAuth = Keypair.generate().publicKey;
    const ix = buildRevokePositionSaleIx({ programId, owner: ownerPk, saleAuth });
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[0]!.pubkey.equals(ownerPk)).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(ix.keys[1]!.pubkey.equals(saleAuth)).toBe(true);
    expect([...ix.data]).toEqual([...REVOKE_POSITION_SALE_DISCRIMINATOR]);
  });
});

// --- Build verification -------------------------------------------------------------------------

const owner = Keypair.generate();
const base = Keypair.generate();
const ownerCookAta = getAssociatedTokenAddressSync(COOK, owner.publicKey, true);
const ownerMonAta = getAssociatedTokenAddressSync(MON, owner.publicKey, true);

function initializeOrderIx(
  over: Partial<{
    makingAmount: bigint;
    takingAmount: bigint;
    expiredAt: number | null;
    kind: number;
    refundNative: boolean;
    trigger: bigint;
    maker: PublicKey;
    order: PublicKey;
    makerInput: PublicKey;
    makerOutput: PublicKey;
    outputMint: PublicKey;
  }> = {},
): TransactionInstruction {
  const order = over.order ?? orderPda(base.publicKey);
  const data = coder.encode("initialize_order", {
    making_amount: new BN((over.makingAmount ?? 1_000_000_000n).toString()),
    taking_amount: new BN((over.takingAmount ?? 750_000_000n).toString()),
    expired_at:
      over.expiredAt === undefined
        ? new BN(2_000_000_000)
        : over.expiredAt == null
          ? null
          : new BN(over.expiredAt),
    kind: over.kind ?? ORDER_KIND_LIMIT,
    refund_native: over.refundNative ?? true,
    trigger_taking_amount: new BN((over.trigger ?? 0n).toString()),
  });
  const k = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      k(base.publicKey, true),
      k(over.maker ?? owner.publicKey, true, true),
      k(order, false, true),
      k(reservePda(order), false, true),
      k(over.makerInput ?? ownerCookAta, false, true),
      k(over.makerOutput ?? ownerMonAta),
      k(COOK),
      k(over.outputMint ?? MON),
      k(TOKEN_PROGRAM_ID),
      k(TOKEN_PROGRAM_ID),
      k(SystemProgram.programId),
    ],
    data,
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

const expected: ExpectedPlace = {
  owner: owner.publicKey,
  inputMint: COOK,
  outputMint: MON,
  makingAmount: 1_000_000_000n,
  takingAmount: 750_000_000n,
  triggerTakingAmount: 0n,
  kind: "limit",
  expiredAt: 2_000_000_000,
  refundNative: true,
  payoutNative: false,
  order: orderPda(base.publicKey),
};

const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });

describe("assertPlaceTxTrustworthy", () => {
  it("accepts the shape the aggregator builds: CU, wrap shortfall, create output ATA, place", () => {
    const tx = compile([
      cu,
      ...wrapIxs(400_000_000),
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        ownerMonAta,
        owner.publicKey,
        MON,
      ),
      initializeOrderIx(),
    ]);
    expect(() => assertPlaceTxTrustworthy(tx, expected)).not.toThrow();
  });

  it("accepts a native COOK payout pinned to the wallet when unwrapSol was requested", () => {
    const tx = compile([cu, initializeOrderIx({ makerOutput: owner.publicKey })]);
    expect(() => assertPlaceTxTrustworthy(tx, { ...expected, payoutNative: true })).not.toThrow();
  });

  it("accepts a stop with a trigger and an ATA refund account", () => {
    const tx = compile([
      cu,
      initializeOrderIx({
        kind: ORDER_KIND_STOP,
        trigger: 750_000_000n,
        takingAmount: 375_000_000n,
        refundNative: false,
      }),
    ]);
    expect(() =>
      assertPlaceTxTrustworthy(tx, {
        ...expected,
        kind: "stop",
        takingAmount: 375_000_000n,
        triggerTakingAmount: 750_000_000n,
        refundNative: false,
        payoutNative: false,
      }),
    ).not.toThrow();
  });

  const cases: Array<[string, () => VersionedTransaction, Partial<ExpectedPlace>?]> = [
    [
      "a different making amount",
      () => compile([cu, initializeOrderIx({ makingAmount: 999_999_999n })]),
    ],
    [
      "a lower taking amount",
      () => compile([cu, initializeOrderIx({ takingAmount: 749_999_999n })]),
    ],
    [
      "a stop kind when a limit was asked",
      () => compile([cu, initializeOrderIx({ kind: ORDER_KIND_STOP, trigger: 750_000_000n })]),
    ],
    ["a different expiry", () => compile([cu, initializeOrderIx({ expiredAt: null })])],
    [
      "another maker",
      () => compile([cu, initializeOrderIx({ maker: Keypair.generate().publicKey })], [base]),
    ],
    [
      "another output mint",
      () => compile([cu, initializeOrderIx({ outputMint: Keypair.generate().publicKey })]),
    ],
    [
      "a payout account that is not ours",
      () => compile([cu, initializeOrderIx({ makerOutput: Keypair.generate().publicKey })]),
    ],
    [
      "a wallet payout when an ATA payout was requested",
      () => compile([cu, initializeOrderIx({ makerOutput: owner.publicKey })]),
    ],
    [
      "an input account that is not ours",
      () => compile([cu, initializeOrderIx({ makerInput: Keypair.generate().publicKey })]),
    ],
    [
      "a refund flag that disagrees with the request",
      () => compile([cu, initializeOrderIx({ refundNative: false })]),
    ],
    [
      "an order address that is not the base's PDA",
      () => compile([cu, initializeOrderIx({ order: Keypair.generate().publicKey })]),
    ],
    [
      "a lamport transfer to a stranger",
      () =>
        compile([
          cu,
          SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
          initializeOrderIx(),
        ]),
    ],
    [
      "an unknown program",
      () =>
        compile([
          cu,
          new TransactionInstruction({
            programId: Keypair.generate().publicKey,
            keys: [],
            data: Buffer.alloc(0),
          }),
          initializeOrderIx(),
        ]),
    ],
    [
      "a token transfer out of our account",
      () =>
        compile([
          cu,
          createTransferInstruction(ownerCookAta, Keypair.generate().publicKey, owner.publicKey, 1),
          initializeOrderIx(),
        ]),
    ],
    [
      "an ATA created for another wallet",
      () => {
        const w = Keypair.generate().publicKey;
        return compile([
          cu,
          createAssociatedTokenAccountIdempotentInstruction(
            owner.publicKey,
            getAssociatedTokenAddressSync(MON, w),
            w,
            MON,
          ),
          initializeOrderIx(),
        ]);
      },
    ],
    ["two program instructions", () => compile([cu, initializeOrderIx(), initializeOrderIx()])],
    ["a missing base pre-signature", () => compile([cu, initializeOrderIx()], [])],
    [
      "a fee payer that is not our wallet",
      () => {
        const p = Keypair.generate();
        return compile([cu, initializeOrderIx()], [base, p], p.publicKey);
      },
    ],
  ];
  for (const [what, build, over] of cases) {
    it(`refuses ${what}`, () => {
      expect(() => assertPlaceTxTrustworthy(build(), { ...expected, ...over })).toThrow(
        /refused before signing/,
      );
    });
  }

  it("refuses a message that resolves accounts through a lookup table", () => {
    const msg = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [cu, initializeOrderIx()],
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
    expect(() => assertPlaceTxTrustworthy(tx, expected)).toThrow(/lookup table/);
  });
});

function cancelOrderIx(order: PublicKey, maker = owner.publicKey): TransactionInstruction {
  const k = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
    pubkey,
    isSigner,
    isWritable,
  });
  return new TransactionInstruction({
    programId: LIMIT_ORDER_PROGRAM_ID,
    keys: [
      k(order, false, true),
      k(maker, true, true),
      k(reservePda(order), false, true),
      k(ownerCookAta, false, true),
      k(COOK),
      k(TOKEN_PROGRAM_ID),
    ],
    data: coder.encode("cancel_order", {}),
  });
}

describe("assertCancelTxTrustworthy", () => {
  const order = orderPda(base.publicKey);
  const exp = { owner: owner.publicKey, order };

  it("accepts CU + recreate ATA + cancel + full unwrap (close to us)", () => {
    const tx = compile(
      [
        cu,
        createAssociatedTokenAccountIdempotentInstruction(
          owner.publicKey,
          ownerCookAta,
          owner.publicKey,
          COOK,
        ),
        cancelOrderIx(order),
        createCloseAccountInstruction(ownerCookAta, owner.publicKey, owner.publicKey),
      ],
      [],
    );
    expect(() => assertCancelTxTrustworthy(tx, exp)).not.toThrow();
  });

  it("accepts a partial unwrap through a pre-signed throwaway account", () => {
    const temp = Keypair.generate();
    const tx = compile(
      [
        cu,
        cancelOrderIx(order),
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: temp.publicKey,
          lamports: 2_039_280,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
        createTransferInstruction(ownerCookAta, temp.publicKey, owner.publicKey, 5),
        createCloseAccountInstruction(temp.publicKey, owner.publicKey, owner.publicKey),
      ],
      [temp],
    );
    expect(() => assertCancelTxTrustworthy(tx, exp)).not.toThrow();
  });

  it("refuses another order, another maker, a close paying a stranger, an unsigned temp", () => {
    expect(() =>
      assertCancelTxTrustworthy(
        compile([cu, cancelOrderIx(Keypair.generate().publicKey)], []),
        exp,
      ),
    ).toThrow(/refused/);
    expect(() =>
      assertCancelTxTrustworthy(
        compile([cu, cancelOrderIx(order, Keypair.generate().publicKey)], []),
        exp,
      ),
    ).toThrow(/refused/);
    expect(() =>
      assertCancelTxTrustworthy(
        compile(
          [
            cu,
            cancelOrderIx(order),
            createCloseAccountInstruction(
              ownerCookAta,
              Keypair.generate().publicKey,
              owner.publicKey,
            ),
          ],
          [],
        ),
        exp,
      ),
    ).toThrow(/refused/);
    const temp = Keypair.generate();
    expect(() =>
      assertCancelTxTrustworthy(
        compile(
          [
            cu,
            cancelOrderIx(order),
            SystemProgram.createAccount({
              fromPubkey: owner.publicKey,
              newAccountPubkey: temp.publicKey,
              lamports: 1,
              space: 165,
              programId: TOKEN_PROGRAM_ID,
            }),
          ],
          [],
        ),
        exp,
      ),
    ).toThrow(/refused/);
  });
});

describe("ALLOWED_PROGRAMS", () => {
  it("is exactly the five programs a place/cancel can touch", () => {
    expect([...ALLOWED_PROGRAMS].sort()).toEqual(
      [
        LIMIT_ORDER_PROGRAM_ID,
        ComputeBudgetProgram.programId,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ]
        .map((p) => p.toBase58())
        .sort(),
    );
  });
});
