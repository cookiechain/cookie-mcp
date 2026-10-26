/**
 * MomoSwap NFT launchpad live check — nothing is signed or sent, and no key is needed:
 *   npx tsx scripts/verify-nft-launchpad.ts
 *   DROP=<collection mint> npx tsx scripts/verify-nft-launchpad.ts
 *
 * 1. Reads: `get_nft_drops` and `get_nft_drop` against api.momoswap.fun.
 * 2. Mint: asks the API to build a real `buy_nft` for a recent buyer that still holds enough native
 *    COOK (or `BUYER=<pubkey>`), holds it to the IDL, then simulates it twice — once with no rent allowance, which
 *    spendGuard refuses while stating what the build would take, and once with `mintBudget`, which
 *    must pass. The difference between the two is the item's real rent, against NFT_ITEM_RENT_ALLOWANCE.
 * 3. Sell: the same for a `sell_nft` of an item its holder still has, under `exitBudget`.
 * 4. Claim: the drop creator's `claim_creator_proceeds`, under `claimBudget`, when it has proceeds.
 * 5. Launch: `create_nft_drop` with `dryRun` over a temporary folder of art (no upload, no session).
 *
 * Simulation runs with sigVerify off, so naming someone else's public key is enough: nothing here can
 * move their funds. A step whose precondition the live drop does not meet (no recent buyer still
 * holding, a drop not live) is reported as skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const API = "https://api.momoswap.fun/v1/nft";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface Trade {
  side: string;
  trader: string;
  nftMint: string;
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const nft = await import("../src/core/nftLaunchpad");
  const api = await import("../src/core/nftLaunchpad/api");
  const { assertNftBuild } = await import("../src/core/nftLaunchpad/verify");
  const { simulateWithinBudget } = await import("../src/core/spendGuard");
  const { getConnection } = await import("../src/core/rpc");
  const conn = getConnection();

  console.log("Reads:");
  const live = await nft.getNftDrops({ status: "live", limit: 5 });
  console.log(
    `  ✓ get_nft_drops(live): ${live.count} drop(s), launches open: ${live.launchesOpen}`,
  );
  for (const d of live.drops) {
    console.log(
      `      ${d.symbol.padEnd(8)} ${d.phase.padEnd(9)} ${d.minted}/${d.totalSupply}  ${d.collectionMint}`,
    );
  }
  const mint = process.env.DROP?.trim() || live.drops[0]?.collectionMint;
  if (!mint) {
    console.log("  – no live drop: pass DROP=<collection mint> to check one");
    return;
  }
  const trades = (await (await fetch(`${API}/collection/${mint}/activity?limit=20`)).json()) as {
    trades?: Trade[];
  };
  const buys = (trades.trades ?? []).filter((t) => t.side === "buy");
  const detail = await nft.getNftDrop({ collection: mint, count: 2, owner: buys[0]?.trader });
  console.log(
    `  ✓ get_nft_drop: ${detail.name} ${detail.phase}, 2 items cost ${detail.mintQuote?.totalCook ?? "—"} COOK, ` +
      `${detail.holdings?.items.length ?? 0} held by ${buys[0]?.trader ?? "—"}`,
  );

  const report = async (label: string, run: () => Promise<unknown>) => {
    try {
      const r = await run();
      console.log(`  ✓ ${label}${r ? `: ${String(r)}` : ""}`);
    } catch (e) {
      console.log(`  ✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  console.log("Mint (built by the API, simulated, never signed):");
  const quote =
    detail.phase === "live"
      ? await api.fetchNftBuyQuote(mint, 1, nft.NFT_DEFAULT_SLIPPAGE_BPS)
      : null;
  const maxSpend = quote ? nft.spendCap(BigInt(quote.totalRaw), nft.NFT_DEFAULT_SLIPPAGE_BPS) : 0n;
  // The build wraps `maxSpend` out of native lamports, so the buyer needs that plus rent in native COOK.
  let buyer = process.env.BUYER?.trim() || null;
  for (const t of buyer ? [] : [...new Set(buys.map((b) => b.trader))]) {
    if (BigInt(await conn.getBalance(new PublicKey(t))) > maxSpend + 100_000_000n) {
      buyer = t;
      break;
    }
  }
  if (!quote || !buyer) {
    console.log(
      `  – skipped: ${quote ? "no recent buyer holds enough COOK (pass BUYER=<funded pubkey>)" : `the drop is ${detail.phase}`}`,
    );
  } else {
    const built = await api.buildNftBuyTx({
      buyer,
      collectionMint: mint,
      maxSpendRaw: maxSpend.toString(),
    });
    const tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
    await report("IDL check", async () =>
      assertNftBuild(tx, "mint", { wallet: buyer!, collectionMint: mint, maxCost: maxSpend }).join(
        " + ",
      ),
    );
    await report("refused with no rent allowance (states what it takes)", async () => {
      try {
        const sim = await simulateWithinBudget(
          conn,
          tx,
          new PublicKey(buyer!),
          { native: BigInt(built.totalRaw) },
          {
            what: "probe",
            source: "MomoSwap NFT API",
          },
        );
        if (sim.value.err) throw nft.nftSimError("probe", sim.value.err, sim.value.logs ?? null);
        return "NOT refused — the build takes no rent?";
      } catch (e) {
        const took = /take (\d+) native/.exec(e instanceof Error ? e.message : "")?.[1];
        if (!took) throw e;
        const rent = BigInt(took) - BigInt(built.totalRaw);
        return `takes ${took} = price ${built.totalRaw} + ${rent} rent/fees (allowance ${nft.NFT_ITEM_RENT_ALLOWANCE + 20_000_000n})`;
      }
    });
    await report("passes mintBudget", async () => {
      const sim = await simulateWithinBudget(
        conn,
        tx,
        new PublicKey(buyer!),
        nft.mintBudget(maxSpend, built.nftMint),
        {
          what: "NFT mint",
          source: "MomoSwap NFT API",
        },
      );
      if (sim.value.err) throw nft.nftSimError("NFT mint", sim.value.err, sim.value.logs ?? null);
      return `${sim.value.unitsConsumed ?? "?"} CU`;
    });
  }

  console.log("Sell (built by the API, simulated, never signed):");
  const holder = buys.find(
    (b) =>
      detail.holdings?.owner === b.trader &&
      detail.holdings.items.some((i) => i.mint === b.nftMint),
  );
  if ((detail.phase !== "live" && detail.phase !== "sold-out") || !holder) {
    console.log(
      `  – skipped: ${holder ? `the drop is ${detail.phase}` : "no recent buyer still holds their item"}`,
    );
  } else {
    const built = await api.buildNftSellTx({
      seller: holder.trader,
      collectionMint: mint,
      nftMint: holder.nftMint,
    });
    const tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
    const min = BigInt(built.minProceedsRaw);
    await report("IDL check", async () =>
      assertNftBuild(tx, "sell", {
        wallet: holder.trader,
        collectionMint: mint,
        nftMint: holder.nftMint,
        minProceeds: min,
      }).join(" + "),
    );
    await report("passes exitBudget", async () => {
      const sim = await simulateWithinBudget(
        conn,
        tx,
        new PublicKey(holder.trader),
        nft.exitBudget(holder.nftMint, min),
        {
          what: "NFT sell-back",
          source: "MomoSwap NFT API",
        },
      );
      if (sim.value.err)
        throw nft.nftSimError("NFT sell-back", sim.value.err, sim.value.logs ?? null);
      return `pays ≥ ${min}`;
    });
  }

  console.log("Creator claim (built by the API, simulated, never signed):");
  const full = await api.fetchNftCollection(mint);
  const proceeds = BigInt(full.creatorProceedsRaw ?? "0");
  if (proceeds === 0n) {
    console.log("  – skipped: the creator has nothing to claim");
  } else {
    const built = await api.buildNftClaimTx({ creator: full.creator, collectionMint: mint });
    const tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
    const own = nft.creatorShare(proceeds, full.partnerShareBps);
    await report("IDL check", async () =>
      assertNftBuild(tx, "claim", { wallet: full.creator, collectionMint: mint }).join(" + "),
    );
    await report("passes claimBudget", async () => {
      const sim = await simulateWithinBudget(
        conn,
        tx,
        new PublicKey(full.creator),
        nft.claimBudget(own),
        {
          what: "NFT creator claim",
          source: "MomoSwap NFT API",
        },
      );
      if (sim.value.err)
        throw nft.nftSimError("NFT creator claim", sim.value.err, sim.value.logs ?? null);
      return `creator gets ≥ ${own} of ${proceeds} (partner ${full.partnerShareBps / 100}%, unwrapped: ${built.unwrapped})`;
    });
  }

  console.log("Launch preview (dryRun: nothing uploaded, no session):");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nft-verify-"));
  process.env.COOKIE_IMAGE_DIR = fs.realpathSync(dir);
  try {
    fs.mkdirSync(path.join(dir, "art"));
    for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(dir, "art", `${i}.png`), PNG);
    await report("create_nft_drop dryRun", async () => {
      const p = (await nft.createNftDrop({
        name: "Verify Drop",
        symbol: "VRFY",
        artDir: path.join(dir, "art"),
        startPriceCook: 100,
        graduationTargetPct: 75,
        dryRun: true,
      })) as {
        firstItemCook?: string;
        lastItemCook?: string;
        raiseAtSelloutCook?: string;
        graduation?: unknown;
      };
      return `first ${p.firstItemCook}, last ${p.lastItemCook}, raise ${p.raiseAtSelloutCook}, graduation ${JSON.stringify(p.graduation)}`;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
