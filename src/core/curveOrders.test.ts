import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import anchorPkg, { type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
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
import { COOK_MINT, PROGRAM_IDS } from "./config";
import { CookieMcpError } from "./errors";
import {
  APPROVE_POSITION_SALE_DISCRIMINATOR,
  LIMIT_ORDER_KEEPER,
  MAX_SALE_AUTH_SECONDS,
  assertCurveBuyWithinPoolLimits,
  buildApprovePositionSaleIx,
  buildCurveBuyPlaceIx,
  buildEnableBuyForIx,
  curveSideFor,
  poolAuthorityPda,
  saleAuthPda,
  saleExpiryFromSeconds,
} from "./curveOrders";
import {
  ENABLE_BUY_FOR_DISCRIMINATOR,
  ORDER_KIND_CURVE_BUY,
  assertPlaceTxTrustworthy,
  buyOptinPda,
  orderPda,
} from "./limitOrders";
import { userPositionPda } from "./launchpad/positions";

const LAUNCHPAD = new PublicKey(PROGRAM_IDS.momoswapLaunchpad);
// STEPH on cookiebox.app and its top holder — the addresses cookiebox's own derivations produce.
const STEPH_POOL = new PublicKey("Dty6tFqaJqRvSKSwVqCFQPByjwiQ2bnoDU524rFkzab5");
const STEPH_MINT = "Am8k8uzAqYZ6J8vQTLkis3ZYgasenien4G5UHeaEmomo";
const HOLDER = new PublicKey("4GGk4vTDd1FCA4NHd62xcwcab86KAm6dFtG7zrGKSGUx");

const sighash = (s: string) => [...createHash("sha256").update(s).digest().subarray(0, 8)];

describe("constants", () => {
  it("discriminators are the anchor sighashes", () => {
    expect([...APPROVE_POSITION_SALE_DISCRIMINATOR]).toEqual(
      sighash("global:approve_position_sale"),
    );
    expect([...ENABLE_BUY_FOR_DISCRIMINATOR]).toEqual(sighash("global:enable_buy_for"));
  });
  it("the keeper is the program's STOP_KEEPER and the cap is 30 days", () => {
    expect(LIMIT_ORDER_KEEPER.toBase58()).toBe("9shiCAJ6ZtpKkoNA5WtK81vZFZa9LSq1JX9SBxSWw8to");
    expect(MAX_SALE_AUTH_SECONDS).toBe(2_592_000);
  });
});

describe("PDAs match cookiebox (golden)", () => {
  it("sale authorization, buy opt-in, pool authority, position", () => {
    expect(saleAuthPda(STEPH_POOL, HOLDER, LIMIT_ORDER_KEEPER, LAUNCHPAD).toBase58()).toBe(
      "D5pDYBDgSGi7AcLLhGLukknaDaEWXWoygiYxQEd6AMZH",
    );
    expect(buyOptinPda(HOLDER, LAUNCHPAD).toBase58()).toBe(
      "8oifbPe9KxqyKFwpoWi9XpYdSmR6ivF25DfsUJkjoNBK",
    );
    expect(poolAuthorityPda(STEPH_POOL, LAUNCHPAD).toBase58()).toBe(
      "6h672nxWmcJwQGMqN15XXbA1TzZRdjskidLudJMhPDUn",
    );
    expect(userPositionPda(STEPH_POOL, HOLDER, LAUNCHPAD).toBase58()).toBe(
      "B2t5D54wMizkFvhb2Uhco428mun2ewfHjfaRDdQ65ceR",
    );
  });
});

describe("curveSideFor", () => {
  const pool = { tokenMint: STEPH_MINT, paymentMint: COOK_MINT };
  it("COOK → token is a buy, token → COOK a sell, anything else is not a curve order", () => {
    expect(curveSideFor(COOK_MINT, STEPH_MINT, pool)).toBe("buy");
    expect(curveSideFor(STEPH_MINT, COOK_MINT, pool)).toBe("sell");
    expect(curveSideFor("MONmint", STEPH_MINT, pool)).toBeNull();
    expect(curveSideFor(STEPH_MINT, "MONmint", pool)).toBeNull();
  });
});

describe("saleExpiryFromSeconds", () => {
  it("defaults to a week, refuses GTC and anything over 30 days", () => {
    expect(saleExpiryFromSeconds(undefined, 1_000)).toBe(1_000 + 7 * 24 * 3600);
    expect(saleExpiryFromSeconds(60, 1_000)).toBe(1_060);
    expect(saleExpiryFromSeconds(MAX_SALE_AUTH_SECONDS, 0)).toBe(MAX_SALE_AUTH_SECONDS);
    expect(() => saleExpiryFromSeconds(0)).toThrow(CookieMcpError);
    expect(() => saleExpiryFromSeconds(MAX_SALE_AUTH_SECONDS + 1)).toThrow(/30 days/);
    expect(() => saleExpiryFromSeconds(1.5)).toThrow(CookieMcpError);
  });

  /**
   * The cap that binds is the SALE's end, not the launchpad's 30-day authorization cap.
   * `approve_position_sale` never reads the pool, but `sell_authorized` refuses past `end_ts` — and
   * a launch runs at most 7 days, so the default of one week is already past the end of most live
   * sales. Unclamped, this mints an order that shows a future expiry and can never fill.
   */
  it("never outlives the sale it sells into", () => {
    const now = 1_000_000;
    const endsIn2h = now + 2 * 3600;
    expect(saleExpiryFromSeconds(undefined, now, endsIn2h)).toBe(endsIn2h);
    expect(saleExpiryFromSeconds(MAX_SALE_AUTH_SECONDS, now, endsIn2h)).toBe(endsIn2h);
    // A shorter ask still stands — the clamp is a ceiling, not a default.
    expect(saleExpiryFromSeconds(600, now, endsIn2h)).toBe(now + 600);
    // No pool end known (an older row): behave exactly as before rather than inventing one.
    expect(saleExpiryFromSeconds(600, now, 0)).toBe(now + 600);
    expect(saleExpiryFromSeconds(600, now, undefined)).toBe(now + 600);
  });
});

describe("assertCurveBuyWithinPoolLimits", () => {
  const pool = { minBuy: "1000000000", maxBuyPerWallet: "10000000000", symbol: "STEPH" };
  it("passes inside the limits, refuses below min and over the per-wallet cap", () => {
    expect(() => assertCurveBuyWithinPoolLimits(pool, 2_000_000_000n, 0n)).not.toThrow();
    expect(() => assertCurveBuyWithinPoolLimits(pool, 999_999_999n, 0n)).toThrow(
      /minimum buy of 1 COOK/,
    );
    expect(() => assertCurveBuyWithinPoolLimits(pool, 2_000_000_000n, 8_500_000_000n)).toThrow(
      /per-wallet cap/,
    );
    expect(() =>
      assertCurveBuyWithinPoolLimits(pool, 2_000_000_000n, 8_000_000_000n),
    ).not.toThrow();
  });
  it("zero limits mean no limit", () => {
    expect(() =>
      assertCurveBuyWithinPoolLimits(
        { minBuy: "0", maxBuyPerWallet: "0", symbol: "X" },
        1n,
        10n ** 30n,
      ),
    ).not.toThrow();
  });
});

describe("buildApprovePositionSaleIx", () => {
  const owner = Keypair.generate().publicKey;
  const payout = Keypair.generate().publicKey;
  const cook = new PublicKey(COOK_MINT);
  const ix = buildApprovePositionSaleIx({
    programId: LAUNCHPAD,
    owner,
    pool: STEPH_POOL,
    paymentMint: cook,
    delegate: LIMIT_ORDER_KEEPER,
    shares: 22_580_000_000n,
    minPaymentOut: 25_660_000_000n,
    expiryTs: 1_760_000_000,
    payoutAccount: payout,
  });
  it("accounts: owner signs, sale_auth writable, pool/authority/payout/mint/system read-only", () => {
    expect(ix.programId.equals(LAUNCHPAD)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      STEPH_POOL.toBase58(),
      poolAuthorityPda(STEPH_POOL, LAUNCHPAD).toBase58(),
      saleAuthPda(STEPH_POOL, owner, LIMIT_ORDER_KEEPER, LAUNCHPAD).toBase58(),
      payout.toBase58(),
      cook.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],
      [false, false],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });
  it("data: disc · delegate · u64 shares · u64 floor · i64 expiry (64 bytes, little-endian)", () => {
    expect(ix.data.length).toBe(64);
    expect([...ix.data.subarray(0, 8)]).toEqual([...APPROVE_POSITION_SALE_DISCRIMINATOR]);
    expect(new PublicKey(ix.data.subarray(8, 40)).equals(LIMIT_ORDER_KEEPER)).toBe(true);
    expect(ix.data.readBigUInt64LE(40)).toBe(22_580_000_000n);
    expect(ix.data.readBigUInt64LE(48)).toBe(25_660_000_000n);
    expect(ix.data.readBigInt64LE(56)).toBe(1_760_000_000n);
  });
});

describe("buildEnableBuyForIx", () => {
  it("owner signs, our opt-in PDA is created, bare discriminator", () => {
    const owner = Keypair.generate().publicKey;
    const ix = buildEnableBuyForIx({ programId: LAUNCHPAD, owner });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      owner.toBase58(),
      buyOptinPda(owner, LAUNCHPAD).toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect([...ix.data]).toEqual([...ENABLE_BUY_FOR_DISCRIMINATOR]);
  });
});

// --- The curve-buy placement, run through the same verifier as an aggregator build ------------------

describe("curve-buy placement passes assertPlaceTxTrustworthy — and tampering does not", () => {
  const coder = new anchorPkg.BorshInstructionCoder(limitOrderIdl as Idl);
  const owner = Keypair.generate();
  const base = Keypair.generate();
  const cook = new PublicKey(COOK_MINT);
  const steph = new PublicKey(STEPH_MINT);
  const making = 5_000_000_000n;
  const taking = 4_000_000_000n;
  const expiredAt = 2_000_000_000;

  const placeIx = (over: Partial<Parameters<typeof buildCurveBuyPlaceIx>[0]> = {}) =>
    buildCurveBuyPlaceIx({
      maker: owner.publicKey,
      base: base.publicKey,
      curvePool: STEPH_POOL,
      launchpadProgramId: LAUNCHPAD,
      inputMint: cook,
      outputMint: steph,
      makingAmount: making,
      takingAmount: taking,
      expiredAt,
      refundNative: true,
      ...over,
    });
  const compile = (ixs: TransactionInstruction[], signBase = true) => {
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: ixs,
      }).compileToV0Message(),
    );
    if (signBase) tx.sign([base]);
    return tx;
  };
  const expectation = (over: Partial<Parameters<typeof assertPlaceTxTrustworthy>[1]> = {}) => ({
    owner: owner.publicKey,
    inputMint: cook,
    outputMint: steph,
    makingAmount: making,
    takingAmount: taking,
    triggerTakingAmount: 0n,
    kind: "curve-buy" as const,
    curve: { pool: STEPH_POOL, programId: LAUNCHPAD },
    expiredAt,
    refundNative: true,
    payoutNative: false,
    order: orderPda(base.publicKey),
    ...over,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });

  it("encodes kind 2 with the position PDA as payout and the pool as the 12th account", () => {
    const ix = placeIx();
    const decoded = coder.decode(ix.data)!;
    expect(decoded.name).toBe("initialize_order");
    expect((decoded.data as { kind: number }).kind).toBe(ORDER_KIND_CURVE_BUY);
    expect(ix.keys).toHaveLength(12);
    expect(ix.keys[5]!.pubkey.equals(userPositionPda(STEPH_POOL, owner.publicKey, LAUNCHPAD))).toBe(
      true,
    );
    expect(ix.keys[11]!.pubkey.equals(STEPH_POOL)).toBe(true);
    expect(
      ix.keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(cook, owner.publicKey, true)),
    ).toBe(true);
  });
  it("accepts the full shape: CU, wrap shortfall, enable_buy_for, place", () => {
    const ata = getAssociatedTokenAddressSync(cook, owner.publicKey, true);
    const tx = compile([
      cu,
      SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: 1_000 }),
      buildEnableBuyForIx({ programId: LAUNCHPAD, owner: owner.publicKey }),
      placeIx(),
    ]);
    expect(() => assertPlaceTxTrustworthy(tx, expectation())).not.toThrow();
  });
  it("accepts a placement without the opt-in", () => {
    expect(() => assertPlaceTxTrustworthy(compile([cu, placeIx()]), expectation())).not.toThrow();
  });
  it("refuses a payout that is a position on ANOTHER pool", () => {
    const other = Keypair.generate().publicKey;
    const ix = placeIx();
    ix.keys[5]!.pubkey = userPositionPda(other, owner.publicKey, LAUNCHPAD);
    expect(() => assertPlaceTxTrustworthy(compile([cu, ix]), expectation())).toThrow(
      /not our position on the curve pool/,
    );
  });
  it("refuses a payout that is someone else's position on the right pool", () => {
    const ix = placeIx();
    ix.keys[5]!.pubkey = userPositionPda(STEPH_POOL, Keypair.generate().publicKey, LAUNCHPAD);
    expect(() => assertPlaceTxTrustworthy(compile([cu, ix]), expectation())).toThrow(
      /not our position/,
    );
  });
  it("refuses a different pool in the trailing account", () => {
    const ix = placeIx();
    ix.keys[11]!.pubkey = Keypair.generate().publicKey;
    expect(() => assertPlaceTxTrustworthy(compile([cu, ix]), expectation())).toThrow(
      /curve pool account/,
    );
  });
  it("refuses a curve-buy when a plain limit was expected, and vice versa", () => {
    expect(() =>
      assertPlaceTxTrustworthy(
        compile([cu, placeIx()]),
        expectation({ kind: "limit", curve: undefined }),
      ),
    ).toThrow(/order kind/);
    expect(() =>
      assertPlaceTxTrustworthy(compile([cu, placeIx()]), expectation({ curve: undefined })),
    ).toThrow(/curve pool expectation/);
  });
  it("refuses an opt-in for ANOTHER wallet riding along", () => {
    const tx = compile([
      cu,
      buildEnableBuyForIx({ programId: LAUNCHPAD, owner: Keypair.generate().publicKey }),
      placeIx(),
    ]);
    // The stranger would have to sign, so the signer check trips first; either way it is refused.
    expect(() => assertPlaceTxTrustworthy(tx, expectation())).toThrow(
      /has not pre-signed|unexpected program/,
    );
  });
  it("refuses any other launchpad instruction (a buy) riding along", () => {
    const stray = new TransactionInstruction({
      programId: LAUNCHPAD,
      keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(sighash("global:buy_v2")),
    });
    expect(() => assertPlaceTxTrustworthy(compile([cu, stray, placeIx()]), expectation())).toThrow(
      /unexpected program/,
    );
  });
  it("refuses when the base seed has not signed", () => {
    expect(() => assertPlaceTxTrustworthy(compile([cu, placeIx()], false), expectation())).toThrow(
      /has not pre-signed/,
    );
  });
  it("refuses a different taking amount or expiry than asked", () => {
    expect(() =>
      assertPlaceTxTrustworthy(
        compile([cu, placeIx({ takingAmount: taking - 1n })]),
        expectation(),
      ),
    ).toThrow(/taking amount/);
    expect(() =>
      assertPlaceTxTrustworthy(compile([cu, placeIx({ expiredAt: null })]), expectation()),
    ).toThrow(/expiry/);
  });
});
