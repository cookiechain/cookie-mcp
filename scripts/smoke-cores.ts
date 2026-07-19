/**
 * Throwaway CP1 smoke: exercise each read core against live Cookie Chain services and print a
 * compact result. Not a unit test (those use fixtures, no live RPC) — just a manual end-to-end check.
 */
import { getChainHealth } from "../src/core/health";
import { getPools } from "../src/core/pools";
import { getTokenInfo } from "../src/core/token";
import { getQuote } from "../src/core/quote";
import { getBalances } from "../src/core/balances";
import { COOK_MINT } from "../src/core/config";

async function main() {
  console.log("== chain_health ==");
  const h = await getChainHealth();
  console.log({
    status: h.status,
    finalizationLag: h.finalizationLag,
    epoch: h.epoch,
    validators: h.validatorCount,
    latencyMs: h.rpc.latencyMs,
  });

  console.log("\n== get_pools (top 3 by TVL) ==");
  const p = await getPools({ limit: 3, sort: "tvl" });
  console.log({ totalPools: p.totalPools });
  for (const pool of p.pools)
    console.log(
      `  ${pool.venue} ${pool.base.symbol}/${pool.quote.symbol} tvl=$${pool.tvlUsd?.toFixed(2)} vol24h=$${pool.volume24hUsd?.toFixed(2) ?? "?"}`,
    );

  const topNonCook = p.pools
    .map((x) => (x.quote.mint === COOK_MINT ? x.base : x.quote))
    .find((s) => s.mint !== COOK_MINT)!;
  console.log(`\n== get_token_info (${topNonCook.symbol}) ==`);
  const t = await getTokenInfo(topNonCook.mint);
  console.log({
    symbol: t.symbol,
    priceUsd: t.priceUsd,
    mcap: t.marketCapUsd,
    holders: t.holderCount,
    decimals: t.decimals,
  });

  console.log(`\n== get_quote (10 COOK -> ${topNonCook.symbol}) ==`);
  const q = await getQuote({ inputMint: COOK_MINT, outputMint: topNonCook.mint, amount: 10 });
  console.log({
    in: `${q.input.amount} ${q.input.symbol}`,
    expectedOut: `${q.output.expectedOut} ${q.output.symbol}`,
    minOut: q.output.minOut,
    impact: q.priceImpactPct,
    feeBps: q.candyShopFee.bps,
    hops: q.route.hops.length,
  });

  console.log("\n== get_balance (a known on-chain wallet) ==");
  const b = await getBalances("568tU9FMksJDxjkLBjWisSA4J4C5uPH87NCCkyREwrxe");
  console.log({
    cook: b.cook.amount,
    cookUsd: b.cook.usdValue?.toFixed(2),
    tokenCount: b.tokens.length,
    totalUsd: b.totalUsd?.toFixed(2),
  });

  console.log("\n✅ all CP1 cores returned live data");
}
main().catch((e) => {
  console.error("❌ smoke failed:", e);
  process.exit(1);
});
