import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import limitOrderIdl from "../idl/limit_order.json" with { type: "json" };
import { COOK_MINT, PROGRAM_IDS } from "./config";
import {
  SETTLE_CURVE_SELL_DISCRIMINATOR,
  buildCreateCurveSellVaultIx,
  buildSettleCurveSellIx,
  curveSellAuthorityPda,
  curveSellVault,
  isCurveSellVaultPayout,
  limitOrderFeePda,
  makerWcookAta,
} from "./curveSellVault";

const LIMIT_ORDER = new PublicKey(PROGRAM_IDS.limitOrder);
const pool = Keypair.generate().publicKey;
const maker = Keypair.generate().publicKey;

type IdlIx = {
  name: string;
  discriminator: number[];
  accounts: { name: string; writable?: boolean; signer?: boolean }[];
  args: { name: string; type: unknown }[];
};
const idlIx = (limitOrderIdl as unknown as { instructions: IdlIx[] }).instructions.find(
  (i) => i.name === "settle_curve_sell",
)!;

describe("the curve-sell vault (limit-order settle_curve_sell)", () => {
  it("derives the authority under the limit-order program and the vault as its wCOOK ATA", () => {
    const authority = curveSellAuthorityPda(pool, maker);
    expect(
      PublicKey.findProgramAddressSync(
        [Buffer.from("curve_sell"), pool.toBuffer(), maker.toBuffer()],
        LIMIT_ORDER,
      )[0].equals(authority),
    ).toBe(true);
    // Off-curve owner (a PDA), so the derivation must allow it; the vault differs per pool.
    expect(PublicKey.isOnCurve(authority.toBytes())).toBe(false);
    expect(
      curveSellVault(pool, maker).equals(curveSellVault(Keypair.generate().publicKey, maker)),
    ).toBe(false);
    expect(makerWcookAta(maker).equals(curveSellVault(pool, maker))).toBe(false);
  });

  it("creates the vault as an idempotent ATA create paid by whoever places", () => {
    const payer = Keypair.generate().publicKey;
    const ix = buildCreateCurveSellVaultIx(payer, pool, maker);
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(curveSellVault(pool, maker))).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(curveSellAuthorityPda(pool, maker))).toBe(true);
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(COOK_MINT);
    expect([...ix.data]).toEqual([1]); // CreateIdempotent
  });

  it("tells a vault payout from a legacy (maker ATA) one", () => {
    expect(
      isCurveSellVaultPayout({ pool, owner: maker, payoutAccount: curveSellVault(pool, maker) }),
    ).toBe(true);
    expect(
      isCurveSellVaultPayout({ pool, owner: maker, payoutAccount: makerWcookAta(maker) }),
    ).toBe(false);
  });

  it("encodes settle_curve_sell exactly as the vendored IDL describes it", () => {
    expect([...SETTLE_CURVE_SELL_DISCRIMINATOR]).toEqual(idlIx.discriminator);
    expect([...SETTLE_CURVE_SELL_DISCRIMINATOR]).toEqual([
      ...createHash("sha256").update("global:settle_curve_sell").digest().subarray(0, 8),
    ]);
    expect(idlIx.args).toEqual([{ name: "close", type: "bool" }]);

    const payer = Keypair.generate().publicKey;
    const ix = buildSettleCurveSellIx({ payer, maker, pool, close: true });
    expect(ix.programId.equals(LIMIT_ORDER)).toBe(true);
    expect([...ix.data]).toEqual([...idlIx.discriminator, 1]);
    expect([...buildSettleCurveSellIx({ payer, maker, pool, close: false }).data].at(-1)).toBe(0);

    expect(ix.keys).toHaveLength(idlIx.accounts.length);
    idlIx.accounts.forEach((a, i) => {
      expect(ix.keys[i]!.isWritable, a.name).toBe(a.writable ?? false);
      expect(ix.keys[i]!.isSigner, a.name).toBe(a.signer ?? false);
    });
    const at = (name: string) => ix.keys[idlIx.accounts.findIndex((a) => a.name === name)]!.pubkey;
    expect(at("payer").equals(payer)).toBe(true);
    expect(at("maker").equals(maker)).toBe(true);
    expect(at("pool").equals(pool)).toBe(true);
    expect(at("authority").equals(curveSellAuthorityPda(pool, maker))).toBe(true);
    expect(at("vault").equals(curveSellVault(pool, maker))).toBe(true);
    expect(at("maker_output_account").equals(makerWcookAta(maker))).toBe(true);
    expect(at("fee").equals(limitOrderFeePda())).toBe(true);
    // The fee vault for wCOOK on Cookie Chain — the one the program insists already exists.
    expect(at("program_fee_account").toBase58()).toBe(
      "3gJ8zdiJF1ST56PfJJKavNz6WTr7PLhhkYKWuD9Q6WsK",
    );
    expect(at("mint").toBase58()).toBe(COOK_MINT);
    expect(at("token_program").equals(TOKEN_PROGRAM_ID)).toBe(true);
  });
});
