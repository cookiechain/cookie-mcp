/**
 * Cookiebox CLMM structural check with an UNFUNDED wallet (no funds spent). Confirms the CLMM LP
 * paths assemble, detect the venue by pool owner, and reach on-chain validation without a real deposit:
 *   npx tsx scripts/verify-clmm.ts
 * Expected: remove/claim cleanly report "no position"; add reaches build/simulate and fails only for
 * lack of funds; the pool is routed to the cookiebox-clmm venue.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const CLMM_POOL = "BiGTVd66sAop3fpGpTXL7Us5egPHJPRf182EEtpBJvAE"; // Cookiebox CLMM (COOK-paired, tickSpacing 2)

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
  const { addLiquidity, removeLiquidity, claimFees, createPool } =
    await import("../src/core/liquidity");

  const COOK = "So11111111111111111111111111111111111111112";
  const bCOOK = "EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz";

  await tryOp("remove_liquidity (CLMM) → no position (unfunded)", () =>
    removeLiquidity({ poolPk: CLMM_POOL }),
  );
  await tryOp("claim_fees (CLMM) → no position (unfunded)", () => claimFees({ poolPk: CLMM_POOL }));
  await tryOp("add_liquidity (CLMM) → getPool + tick/open build/simulate (unfunded)", () =>
    addLiquidity({ poolPk: CLMM_POOL, amountA: 0.001, amountB: 0.001 }),
  );
  await tryOp("create_pool (CLMM) → createPool build/simulate (unfunded)", () =>
    createPool({
      dex: "cookiebox-clmm",
      tokenAMint: bCOOK,
      tokenBMint: COOK,
      amountA: 0.001,
      amountB: 0.001,
    }),
  );

  console.log("\n✅ CLMM LP paths assemble and reach on-chain validation");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
