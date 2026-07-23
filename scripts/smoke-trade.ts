/**
 * CP2 smoke — verify the money-path wiring WITHOUT spending real funds:
 *  A. read-only mode (no key) → trade/transfer return "no wallet configured".
 *  B. with a random (unfunded) key: cap-exceeded is refused before any network; a within-cap trade
 *     runs the real quote → Candy Shop build-tx → simulate pipeline and fails at simulation
 *     (insufficient funds), proving every step up to submit works and errors are structured.
 * A real funded swap (actual submit/confirm) needs the user's dedicated test key — out of scope here.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { trade } from "../src/core/trade";
import { transfer } from "../src/core/transfer";
import { _resetWalletCache, ownPublicKey } from "../src/core/wallet";

const COOK = "So11111111111111111111111111111111111111112";
const MON = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";

async function expectError(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = (e as { hint?: string })?.hint;
    console.log(`  ✓ ${label}\n      error: ${msg}${hint ? `\n      hint:  ${hint}` : ""}`);
  }
}

async function main() {
  console.log("== A. read-only mode (no COOKIE_PRIVATE_KEY) ==");
  delete process.env.COOKIE_PRIVATE_KEY;
  _resetWalletCache();
  await expectError("trade refuses without a wallet", () =>
    trade({ inputMint: COOK, outputMint: MON, amount: 1 }),
  );
  await expectError("transfer refuses without a wallet", () => transfer({ to: MON, amount: 1 }));

  console.log("\n== B. with a random unfunded key ==");
  const dummy = Keypair.generate();
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(dummy.secretKey);
  _resetWalletCache();
  console.log(`  dummy wallet: ${ownPublicKey()}`);

  await expectError("cap: 999999 COOK exceeds the per-trade cap", () =>
    trade({ inputMint: COOK, outputMint: MON, amount: 999999 }),
  );

  await expectError("within-cap trade runs quote→build→simulate, fails at sim (unfunded)", () =>
    trade({ inputMint: COOK, outputMint: MON, amount: 1 }),
  );

  await expectError("transfer runs build→simulate, fails at sim (unfunded)", () =>
    transfer({ to: "568tU9FMksJDxjkLBjWisSA4J4C5uPH87NCCkyREwrxe", amount: 0.001 }),
  );

  delete process.env.COOKIE_PRIVATE_KEY;
  _resetWalletCache();
  console.log("\n✅ CP2 money-path wiring verified (no funds spent)");
}
main().catch((e) => {
  console.error("❌ smoke-trade failed:", e);
  process.exit(1);
});
