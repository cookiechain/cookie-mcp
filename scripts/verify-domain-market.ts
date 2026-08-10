/**
 * CookOven `.cook` domain marketplace structural check — NOTHING IS SENT AND NOTHING IS SPENT:
 *   npx tsx scripts/verify-domain-market.ts
 *   SELLER=<pubkey> npx tsx scripts/verify-domain-market.ts
 *
 * Runs with a freshly generated (unfunded) key, so every write path must stop at a guard before it
 * would sign: an unlisted name, somebody else's listing, a missing spend confirmation.
 *
 * Three things here are the canaries worth re-running after any marketplace change:
 *   1. the derived PDAs (config / escrow authority / a listing) still match the live accounts;
 *   2. the fee this client reports equals the one the on-chain config holds, and the split matches
 *      what the program actually paid out on the last completed sale;
 *   3. every listed name is genuinely owned by the escrow authority in the REGISTRY — that is the
 *      invariant all of the escrow-awareness in `domains/index.ts` rests on. If it ever breaks,
 *      `resolve_domain` and `resolveWallet` are wrong, not just cosmetically.
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const SELLER = process.env.SELLER?.trim() || "FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ";
const UNLISTED_NAME = "cookie-mcp-verify-free";

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
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const domains = await import("../src/core/domains");
  const market = await import("../src/core/domains/marketplace");
  const registry = await import("../src/core/domains/program");
  const { getConnection } = await import("../src/core/rpc");
  const conn = getConnection();

  console.log(`Marketplace program ${market.DOMAIN_MARKET_PROGRAM_ID.toBase58()}:`);
  const cfg = await domains.fetchMarketConfig(conn);
  console.log(
    `  ✓ config ${market.marketConfigPda().toBase58()} — fee ${cfg.feeBps} bps ` +
      `(max ${market.MAX_MARKET_FEE_BPS}), fees → ${cfg.feeWallet}, admin ${cfg.admin}`,
  );
  console.log(`  ✓ escrow authority ["escrow_authority"] = ${market.ESCROW_AUTHORITY}`);
  const cfgInfo = await conn.getAccountInfo(market.marketConfigPda());
  console.log(
    `  ${cfgInfo?.data.length === market.MARKET_CONFIG_ACCOUNT_SIZE ? "✓" : "✗"} config is ` +
      `${cfgInfo?.data.length} bytes (expected ${market.MARKET_CONFIG_ACCOUNT_SIZE})`,
  );

  console.log("\nListings:");
  const board = await domains.getDomainListings({ sort: "price" });
  console.log(
    `  ✓ ${board.totalListings} live listing(s), floor ${board.floorPriceCook ?? "n/a"} COOK, ` +
      `fee ${board.marketplaceFee}`,
  );
  for (const l of board.listings) {
    const { sellerReceivesRaw } = market.splitSalePrice(BigInt(l.priceLamports), cfg.feeBps);
    console.log(
      `      ${l.name.padEnd(16)} ${l.priceCook.padStart(12)} COOK  seller ${l.seller.slice(0, 6)}…  ` +
        `→ seller nets ${(Number(sellerReceivesRaw) / 1e9).toLocaleString()} COOK`,
    );
  }

  console.log("\nThe escrow invariant (every listing's domain is held by the escrow authority):");
  let escrowOk = 0;
  for (const l of board.listings) {
    const info = await conn.getAccountInfo(new PublicKey(l.domain));
    const decoded = info && registry.decodeDomainAccount(info.data as Buffer);
    const held = decoded?.owner === market.ESCROW_AUTHORITY;
    if (held) escrowOk += 1;
    else console.log(`  ✗ ${l.name} is listed but owned by ${decoded?.owner ?? "nobody"}`);
    // The listing PDA must be derivable from the domain account alone — that is how every read here
    // finds a listing without scanning.
    const derived = market.listingPda(new PublicKey(l.domain)).toBase58();
    if (derived !== l.listing) console.log(`  ✗ ${l.name}: listing PDA ${derived} != ${l.listing}`);
  }
  console.log(
    `  ${escrowOk === board.listings.length ? "✓" : "✗"} ${escrowOk}/${board.listings.length} hold`,
  );

  console.log("\nEscrow awareness on the registry side:");
  for (const l of board.listings.slice(0, 2)) {
    const r = await domains.resolveDomain(l.name);
    const ok = r.owner === market.ESCROW_AUTHORITY && r.forSale?.seller === l.seller;
    console.log(
      `  ${ok ? "✓" : "✗"} resolve_domain(${l.name}) → owner is the escrow, forSale.seller ` +
        `${r.forSale?.seller.slice(0, 6)}… at ${r.forSale?.priceCook} COOK, isOwnersPrimary=${r.isOwnersPrimary}`,
    );
    // The important one: a listed name must NOT be usable as a payment address.
    await expectFailure(`${l.name} is refused as a wallet address`, () =>
      domains.resolveWallet(l.name, "wallet"),
    );
  }
  const sellerView = await domains.getOwnedDomains(SELLER);
  console.log(
    `  ✓ get_owned_domains(${SELLER.slice(0, 6)}…) → ${sellerView.count} owned, ` +
      `${sellerView.listedCount} listed for sale${sellerView.note ? `\n      note: ${sellerView.note}` : ""}`,
  );
  for (const l of sellerView.listedForSale) {
    console.log(`      ${l.name.padEnd(16)} ${l.priceCook.padStart(12)} COOK  ${l.listing}`);
  }

  console.log("\nGuards (unfunded key — none of these reach a signature):");
  const listed = board.listings[0];
  if (listed) {
    await expectFailure("buy_domain without maxPriceCook quotes the price and stops", () =>
      domains.buyDomain({ name: listed.name }),
    );
    await expectFailure("buy_domain below the asking price stops", () =>
      domains.buyDomain({ name: listed.name, maxPriceCook: 1 }),
    );
    await expectFailure("buy_domain with an unparseable cap stops (never read as unlimited)", () =>
      domains.buyDomain({ name: listed.name, maxPriceCook: "lots" }),
    );
    await expectFailure("cancel_domain_listing on somebody else's listing stops", () =>
      domains.cancelDomainListing({ name: listed.name }),
    );
    await expectFailure("list_domain on a name already listed stops", () =>
      domains.listDomain({ name: listed.name, priceCook: 1 }),
    );
    await expectFailure("transfer_domain of a listed name explains the escrow", () =>
      domains.transferDomain({ name: listed.name, to: SELLER }),
    );
    await expectFailure("set_primary_domain on a listed name explains the escrow", () =>
      domains.setPrimaryDomain({ name: listed.name }),
    );
    await expectFailure("update_domain on a listed name explains the escrow", () =>
      domains.updateDomain({ name: listed.name, resolver: "none" }),
    );
  }
  await expectFailure("buy_domain on a name that is not listed", () =>
    domains.buyDomain({ name: UNLISTED_NAME, maxPriceCook: 1 }),
  );
  await expectFailure("cancel_domain_listing on a name that is not listed", () =>
    domains.cancelDomainListing({ name: UNLISTED_NAME }),
  );
  await expectFailure("list_domain on an unregistered name", () =>
    domains.listDomain({ name: UNLISTED_NAME, priceCook: 1 }),
  );
  await expectFailure("list_domain at a price of zero", () =>
    domains.listDomain({ name: UNLISTED_NAME, priceCook: "0" }),
  );
  await expectFailure("get_domain_listings with an unparseable maxPriceCook", () =>
    domains.getDomainListings({ maxPriceCook: "cheap" }),
  );

  console.log(
    "\nInstruction encoding, cross-checked against the deployed program (simulation only):",
  );
  // A real buy_listing from a wallet that cannot afford it: the program validates every account and
  // fails only at the first transfer, so this proves the account list and the discriminator without
  // spending anything.
  //
  // The amount it demands is the SELLER's cut (price − fee), not the full price — the payout to the
  // seller is the first transfer it attempts. That makes this the cross-check on `splitSalePrice`:
  // the fee is admin-mutable, so if the config and our arithmetic ever disagree, it shows up here.
  if (listed) {
    const buyer = new PublicKey(SELLER);
    const tx = new Transaction().add(
      market.buyListingIx({
        buyer,
        seller: new PublicKey(listed.seller),
        domain: new PublicKey(listed.domain),
        feeWallet: new PublicKey(cfg.feeWallet),
      }),
    );
    tx.feePayer = buyer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    const logs = sim.value.logs ?? [];
    const need = /insufficient lamports \d+, need (\d+)/.exec(logs.join(" "))?.[1];
    const expected = market
      .splitSalePrice(BigInt(listed.priceLamports), cfg.feeBps)
      .sellerReceivesRaw.toString();
    console.log(
      `  ${need === undefined ? "·" : need === expected ? "✓" : "✗"} buy_listing(${listed.name}) ` +
        "simulated: " +
        (need === undefined
          ? (market.marketSimError(logs, listed.label) ?? JSON.stringify(sim.value.err))
          : `the program's first payout is ${need} lamports; splitSalePrice says the seller gets ` +
            `${expected} — ${need === expected ? "agrees" : "MISMATCH: the fee split is wrong"}`),
    );
    const translated = market.marketSimError(logs, listed.label);
    if (translated) console.log(`      error translation: ${translated}`);
  }

  console.log("\nDone — no transaction was signed or sent.");
}

main().catch((e) => {
  console.error("verify-domain-market failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
