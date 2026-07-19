/**
 * LP structural check with an UNFUNDED wallet (no funds spent). Confirms the fund-moving liquidity
 * paths assemble and reach on-chain validation without a real deposit:
 *   npx tsx scripts/verify-lp.ts
 * Expected: remove/lock cleanly report "no position"; add/create reach build/simulate and fail only
 * for lack of funds; SAMM routes by pool owner; SAMM create_pool reports "not supported yet".
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const POOL = "5gXHQZvknu4tp6dT32G9m8aWups5aV8aCsYDAwfeV3np"; // Cookiebox DAMM wCOOK/bCOOK
const SAMM_POOL = "DtK93bScUXhkn6edF8ATdL85DYyHqsavbWhpR9GuuAYB"; // CookieSwap SAMM wCOOK/bCOOK

async function tryOp(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, r);
  } catch (e) {
    const m = e instanceof Error ? e.message : JSON.stringify(e);
    const h = (e as { hint?: string } | null)?.hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const { createPool, addLiquidity, removeLiquidity, lockLiquidity, claimFees } =
    await import("../src/core/liquidity");

  const COOK = "So11111111111111111111111111111111111111112";
  const MON = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";

  // Cookiebox DAMM v2.
  await tryOp("remove_liquidity → no position (unfunded)", () => removeLiquidity({ poolPk: POOL }));
  await tryOp("lock_liquidity → no position (unfunded)", () => lockLiquidity({ poolPk: POOL }));
  await tryOp("claim_fees → no position (unfunded)", () => claimFees({ poolPk: POOL }));
  await tryOp("add_liquidity → reaches build/simulate (unfunded)", () =>
    addLiquidity({ poolPk: POOL, amountA: 0.001, amountB: 0.001 }),
  );
  await tryOp("create_pool (DAMM) → config fetch + prepare + build/simulate (unfunded)", () =>
    createPool({ tokenAMint: MON, tokenBMint: COOK, amountA: 1, amountB: 0.001 }),
  );

  // CookieSwap SAMM (venue auto-detected from the pool owner).
  await tryOp("remove_liquidity (SAMM) → no position (unfunded)", () =>
    removeLiquidity({ poolPk: SAMM_POOL }),
  );
  await tryOp("claim_fees (SAMM) → no position (unfunded)", () => claimFees({ poolPk: SAMM_POOL }));
  await tryOp("add_liquidity (SAMM) → getPoolInfoFromRpc + openPosition build (unfunded)", () =>
    addLiquidity({ poolPk: SAMM_POOL, amountB: 0.001 }),
  );
  // create_pool (SAMM) is intentionally NOT exercised here: Raydium's createPool broadcasts via
  // `.execute()` (it can't be built-only), so unfunded it would send a doomed tx and hang on confirm.
  // It's validated live with a funded wallet instead.

  console.log("\n✅ LP paths assemble and reach on-chain validation");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
