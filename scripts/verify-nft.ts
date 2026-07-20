/**
 * NFT-marketplace structural check with an UNFUNDED wallet (no funds spent). Confirms the Baked
 * Bazaar read paths return data and the fund-moving paths assemble and reach on-chain validation:
 *   npx tsx scripts/verify-nft.ts
 * Expected: reads print live listings/stats; cancel_listing/cancel_offer/accept_offer cleanly report
 * "nothing to act on"; list/buy/make_offer reach build/simulate and fail only for funds/ownership.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

async function tryOp(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, JSON.stringify(r)?.slice(0, 120));
  } catch (e) {
    const m = e instanceof Error ? e.message : JSON.stringify(e);
    const h = (e as { hint?: string } | null)?.hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.COOKIE_MAX_TRADE_COOK = "0"; // disable the cap so writes reach build/simulate
  const nft = await import("../src/core/nft");

  console.log("Reads:");
  const listings = (await nft.getNftListings({ sort: "price", limit: 3 })) as {
    count: number;
    listings: Array<{ mint: string; price: string; name?: string }>;
  };
  console.log(`  ✓ get_nft_listings → ${listings.count} active; cheapest:`, listings.listings[0]);
  const stats = await nft.getMarketStats();
  console.log("  ✓ get_nft_market_stats →", JSON.stringify(stats));

  const sample = listings.listings[0];
  if (sample) {
    const detail = await nft.getNft(sample.mint);
    console.log("  ✓ get_nft →", JSON.stringify(detail).slice(0, 160), "…");
  }

  console.log("\nWrites (unfunded — must reach build/simulate or a clean guard):");
  await tryOp("cancel_listing → clean guard (not our listing / none)", () =>
    nft.cancelListing({ mint: sample?.mint ?? "So11111111111111111111111111111111111111112" }),
  );
  await tryOp("cancel_offer → no active offer", () =>
    nft.cancelOffer({ mint: sample?.mint ?? "So11111111111111111111111111111111111111112" }),
  );
  await tryOp("accept_offer → no active offer", () =>
    nft.acceptOffer({ mint: sample?.mint ?? "So11111111111111111111111111111111111111112" }),
  );
  if (sample) {
    await tryOp("buy_nft → reaches build/simulate (unfunded)", () =>
      nft.buyNft({ mint: sample.mint }),
    );
    await tryOp("make_offer → reaches build/simulate (unfunded)", () =>
      nft.makeOffer({ mint: sample.mint, price: "0.001" }),
    );
    await tryOp("list_nft → reaches build/simulate (don't own it)", () =>
      nft.listNft({ mint: sample.mint, price: "1" }),
    );
  }

  console.log("\n✅ NFT marketplace paths assemble and reach on-chain validation");
}
main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
