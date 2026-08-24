/**
 * Solana/Jupiter swap-path check. Spends NOTHING: it quotes live (quotes need no wallet and no RPC),
 * then proves every guard on the money path fires before anything is signed:
 *   npx tsx scripts/verify-jupiter.ts
 * Expected: both quotes print a route through a real Solana AMM; all four guards report their reason.
 */
import { getQuote } from "../src/core/quote";
import { trade } from "../src/core/trade";
import { BRIDGE, SOL_MINT, isPublicSolanaRpc } from "../src/core/config";

const COOK_SPL = BRIDGE.solana.splMint;

async function expectError(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected a refusal, got`, JSON.stringify(r)?.slice(0, 160));
  } catch (e) {
    const err = e as { error?: string; message?: string; hint?: string };
    console.log(`  ✓ ${label}: ${err.error ?? err.message}`);
    if (err.hint) console.log(`      hint: ${err.hint}`);
  }
}

async function quote(label: string, a: Parameters<typeof getQuote>[0]): Promise<void> {
  try {
    const q = await getQuote(a);
    console.log(
      `  ✓ ${label}: ${q.input.amount} ${q.input.symbol} -> ${q.output.expectedOut} ` +
        `${q.output.symbol} (min ${q.output.minOut}), impact ${q.priceImpactPct}, ` +
        `via ${q.route.hops.map((h) => h.venue).join(" + ")} [${q.chain}/${q.aggregator}]`,
    );
  } catch (e) {
    console.log(`  ✗ ${label}:`, (e as Error).message);
  }
}

console.log("Solana COOK quotes (live Jupiter, no wallet, no RPC):");
await quote("buy COOK with 1 SOL", {
  inputMint: SOL_MINT,
  outputMint: COOK_SPL,
  amount: 1,
  chain: "solana",
});
await quote("sell 1,000,000 COOK for SOL", {
  inputMint: COOK_SPL,
  outputMint: SOL_MINT,
  amount: 1_000_000,
  chain: "solana",
});

console.log("\nGuards:");
await expectError("a Cookie Chain aggregator is rejected on Solana", () =>
  getQuote({
    inputMint: SOL_MINT,
    outputMint: COOK_SPL,
    amount: 1,
    chain: "solana",
    aggregator: "cookiebox",
  }),
);
// Keeps a COOK leg on purpose, so this exercises the decimals guard rather than the COOK-pair guard.
await expectError("an unindexed mint is refused rather than assumed 9-decimal", () =>
  getQuote({
    inputMint: COOK_SPL,
    outputMint: "11111111111111111111111111111112",
    amount: 1,
    chain: "solana",
  }),
);
await expectError("an unrelated Solana pair (SOL -> USDC) is refused — COOK-only", () =>
  getQuote({
    inputMint: SOL_MINT,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: 1,
    chain: "solana",
  }),
);
await expectError("same mint in and out", () =>
  getQuote({ inputMint: SOL_MINT, outputMint: SOL_MINT, amount: 1, chain: "solana" }),
);
console.log(
  `  (SOLANA_RPC_URL is ${isPublicSolanaRpc() ? "the PUBLIC endpoint" : "a dedicated RPC"})`,
);
await expectError("trade refuses the public RPC / no wallet before signing", () =>
  trade({ inputMint: SOL_MINT, outputMint: COOK_SPL, amount: 0.0001, chain: "solana" }),
);
