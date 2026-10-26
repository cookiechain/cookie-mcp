/**
 * Aera money-market check against the live chain.
 *
 *   npx tsx scripts/verify-lending.ts                 # reads + guard checks, NOTHING SENT OR SPENT
 *   LIVE=1 npx tsx scripts/verify-lending.ts          # also runs a dust round trip with the env key
 *
 * Read mode runs with a freshly generated (unfunded) key: every write must stop at a guard before it
 * would sign (no balance, no collateral, no debt). It also builds a real `lend` transaction for a
 * known borrower's wallet and simulates it with signature verification off, so the account shape
 * and the same-slot prelude are checked against the deployed program without a key.
 *
 * LIVE mode uses COOKIE_PRIVATE_KEY and moves dust: lend 1 COOK → withdraw it; deposit ~1 bCOOK of
 * collateral (staking 2 COOK for it first if the wallet holds none) → borrow 0.5 COOK → repay all →
 * withdraw the collateral. Every step is a real transaction; the amounts are chosen so the whole
 * cycle costs well under 0.1 COOK in fees.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const BORROWER = process.env.BORROWER?.trim() || "EH5c4qiAzQhMmWbabbB8QjgZ9VU6DoSfy2HJYRJwvsFv";
const LIVE = process.env.LIVE === "1";

async function expectFailure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, JSON.stringify(r)?.slice(0, 160));
  } catch (e) {
    const m = e instanceof Error ? e.message : JSON.stringify(e);
    const h = (e as { hint?: string } | null)?.hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  const realKey = process.env.COOKIE_PRIVATE_KEY?.trim();
  if (!LIVE || !realKey) {
    process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  }
  const lending = await import("../src/core/lending");
  const { requireSigner } = await import("../src/core/wallet");

  console.log("== get_lending_markets");
  const markets = await lending.getLendingMarkets();
  console.log(JSON.stringify(markets, null, 2));

  console.log(`\n== get_lending_position (${BORROWER})`);
  console.log(JSON.stringify(await lending.getLendingPosition(BORROWER), null, 2));

  if (!LIVE || !realKey) {
    console.log("\n== guards with an unfunded key (nothing is sent)");
    await expectFailure("lend 1 COOK with no balance", () =>
      lending.lend({ asset: "COOK", amount: 1 }),
    );
    await expectFailure("withdraw_lend with no shares", () =>
      lending.withdrawLend({ asset: "COOK", amount: "all" }),
    );
    await expectFailure("deposit_collateral with no bCOOK", () =>
      lending.depositCollateral({ amount: 1 }),
    );
    await expectFailure("borrow with no obligation", () => lending.borrow({ amount: 1 }));
    await expectFailure("repay with no debt", () => lending.repay({ amount: "all" }));
    await expectFailure("withdraw_collateral with no obligation", () =>
      lending.withdrawCollateral({ amount: "all" }),
    );
    await expectFailure("unknown asset", () => lending.lend({ asset: "DOGE", amount: 1 }));

    console.log(
      "\n== full flows in external-signer mode: every check + simulation, stops before signing",
    );
    // The flows build the exact transaction they would send, simulate it on the RPC, then hand it
    // to the (absent) wallet — so a `needs_signature` result proves the deployed program accepted
    // the account shape and the same-slot prelude, with nothing signed or spent.
    const { runWithRequestContext } = await import("../src/core/context");
    const { SignatureRequired } = await import("../src/core/signer");
    const dryRun = async (wallet: string, label: string, fn: () => Promise<unknown>) => {
      const prev = { signer: process.env.COOKIE_SIGNER, wallet: process.env.COOKIE_WALLET_ADDRESS };
      process.env.COOKIE_SIGNER = "external";
      process.env.COOKIE_WALLET_ADDRESS = wallet;
      try {
        const r = await runWithRequestContext({ wallet }, fn);
        console.log(
          `  ✗ ${label}: returned without a signature step`,
          JSON.stringify(r)?.slice(0, 160),
        );
      } catch (e) {
        if (e instanceof SignatureRequired) {
          const p = e.payload as { kind: string; what: string; transaction?: string };
          console.log(
            `  ✓ ${label}: simulated OK, needs_signature (${p.what}, ${p.kind}${p.transaction ? `, ${Buffer.from(p.transaction, "base64").length} bytes` : ""})`,
          );
        } else {
          const m = e instanceof Error ? e.message : JSON.stringify(e);
          const h = (e as { hint?: string } | null)?.hint;
          console.log(`  · ${label}: refused before simulation — ${m}${h ? ` (hint: ${h})` : ""}`);
        }
      } finally {
        process.env.COOKIE_SIGNER = prev.signer ?? "";
        process.env.COOKIE_WALLET_ADDRESS = prev.wallet ?? "";
      }
    };
    const SUPPLIER = process.env.SUPPLIER?.trim() || BORROWER;
    await dryRun(SUPPLIER, "lend 1 COOK", () => lending.lend({ asset: "COOK", amount: 1 }));
    await dryRun(SUPPLIER, "withdraw_lend 1 COOK", () =>
      lending.withdrawLend({ asset: "COOK", amount: 1 }),
    );
    await dryRun(SUPPLIER, "withdraw_lend all aCOOK (may exceed available liquidity)", () =>
      lending.withdrawLend({ asset: "COOK", amount: "all" }),
    );
    await dryRun(BORROWER, "borrow 1 COOK", () => lending.borrow({ amount: 1 }));
    await dryRun(BORROWER, "borrow beyond the LTV limit", () =>
      lending.borrow({ amount: 10_000_000 }),
    );
    await dryRun(BORROWER, "repay 1 COOK", () => lending.repay({ amount: 1 }));
    await dryRun(BORROWER, "repay all", () => lending.repay({ amount: "all" }));
    await dryRun(BORROWER, "withdraw_collateral 1 bCOOK", () =>
      lending.withdrawCollateral({ amount: 1 }),
    );
    await dryRun(BORROWER, "withdraw_collateral 1 bCOOK keepShares", () =>
      lending.withdrawCollateral({ amount: 1, keepShares: true }),
    );
    await dryRun(BORROWER, "withdraw_collateral all (must refuse: loan outstanding)", () =>
      lending.withdrawCollateral({ amount: "all" }),
    );
    await dryRun(BORROWER, "deposit_collateral 1 bCOOK", () =>
      lending.depositCollateral({ amount: 1 }),
    );
    return;
  }

  // ---- LIVE dust round trip -------------------------------------------------------------------
  const signer = requireSigner();
  console.log(`\n== LIVE round trip with ${signer.publicKey.toBase58()}`);
  const before = await lending.getLendingPosition();
  console.log("position before:", JSON.stringify(before, null, 1));

  console.log("\n-- lend 1 COOK");
  console.log(await lending.lend({ asset: "COOK", amount: 1 }));
  console.log("\n-- withdraw_lend 1 COOK");
  console.log(await lending.withdrawLend({ asset: "COOK", amount: 1 }));

  const { getBalances } = await import("../src/core/balances");
  const { BCOOK_MINT } = await import("../src/core/stake");
  const bal = await getBalances(signer.publicKey.toBase58());
  const bcook = bal.tokens.find((t) => t.mint === BCOOK_MINT.toBase58());
  if (!bcook || Number(bcook.amount) < 1) {
    console.log("\n-- stake 2 COOK for bCOOK (none held)");
    const { stake } = await import("../src/core/stake");
    console.log(await stake({ amount: 2 }));
  }

  console.log("\n-- deposit_collateral 1 bCOOK");
  console.log(await lending.depositCollateral({ amount: 1 }));
  console.log("\n-- borrow 0.5 COOK");
  console.log(await lending.borrow({ amount: 0.5 }));
  console.log("\n-- position mid-cycle");
  console.log(JSON.stringify(await lending.getLendingPosition(), null, 1));
  console.log("\n-- repay all");
  console.log(await lending.repay({ amount: "all" }));
  console.log("\n-- withdraw_collateral all");
  console.log(await lending.withdrawCollateral({ amount: "all" }));
  console.log("\n-- position after");
  console.log(JSON.stringify(await lending.getLendingPosition(), null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
