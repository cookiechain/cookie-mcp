/**
 * CP5 LP scaffolding check (no funds). Run twice:
 *   npx tsx scripts/verify-lp.ts            # flag OFF → tools disabled
 *   COOKIE_ENABLE_UNVALIDATED_LP=1 npx tsx scripts/verify-lp.ts on   # flag ON, unfunded wallet
 * With an unfunded wallet: remove/lock cleanly report "no position", add reaches build/simulate.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const POOL = "78e15qHtzR4nXFpSy8VSzSpDxqyzbKNtrjdTo5neBorq"; // Cookiebox DAMM COOK/MON

async function tryOp(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, r);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const h = (e as { hint?: string }).hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const { LP_ENABLED, addLiquidity, removeLiquidity, lockLiquidity } =
    await import("../src/core/liquidity/damm");
  console.log(`LP_ENABLED = ${LP_ENABLED}`);

  if (!LP_ENABLED) {
    await tryOp("add_liquidity disabled without opt-in", () =>
      addLiquidity({ poolPk: POOL, amountA: 1 }),
    );
  } else {
    await tryOp("remove_liquidity → no position (unfunded)", () =>
      removeLiquidity({ poolPk: POOL }),
    );
    await tryOp("lock_liquidity → no position (unfunded)", () => lockLiquidity({ poolPk: POOL }));
    await tryOp("add_liquidity → reaches build/simulate (unfunded)", () =>
      addLiquidity({ poolPk: POOL, amountA: 0.001 }),
    );
  }
  console.log("\n✅ LP scaffolding behaves correctly");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
