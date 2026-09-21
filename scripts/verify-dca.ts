/**
 * DCA structural check against a LIVE Cookiebox aggregator — NOTHING IS SIGNED, NOTHING IS SENT,
 * NOTHING IS SPENT:
 *   npx tsx scripts/verify-dca.ts
 *   COOKIEBOX_AGG_API_URL=http://127.0.0.1:3199 OWNER=<funded pubkey> npx tsx scripts/verify-dca.ts
 *
 * ⚠️ The `/dca` routes are gated behind cookiebox's `config.json` → `dcaOrders.enabled`, which is
 * OFF on the deployed aggregator: against production every route answers 503 and this script
 * reports that (a pass for the "disabled" hint, no build to verify). Point `COOKIEBOX_AGG_API_URL`
 * at a local agg with the flag flipped on to exercise the real builds.
 *
 * `OWNER` is only a public key the aggregator builds FOR (its server-side simulation needs a wallet
 * that can cover the budget); we never hold its secret. The script asks for a real `open-tx`, runs
 * the same pre-sign verification `open_dca` runs, simulates it on our RPC with signature checks
 * off, proves a tampered expectation is refused, and then flips to a freshly generated (unfunded)
 * key to show the client-side guards firing before any API call.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// A funded public wallet (the limit-order program admin), so the agg's simulation of a wrap+open passes.
const OWNER = process.env.OWNER?.trim() || "HGSGbiM3tMvbX8cxitEgzbQv53M4rFcsE1gn7fvrHrkN";
const COOK = "So11111111111111111111111111111111111111112";
const OUTPUT = process.env.OUTPUT?.trim() || "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL"; // MON
const BUDGET_RAW = 10_000_000n; // 0.01 COOK, in 4 cycles
const PER_CYCLE_RAW = 2_500_000n;
const CYCLE_SECONDS = 3_600;

async function expectFailure(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    console.log(`  ✗ ${label}: expected an error, got`, JSON.stringify(r)?.slice(0, 160));
    process.exitCode = 1;
  } catch (e) {
    const m = e instanceof Error ? e.message : JSON.stringify(e);
    const h = (e as { hint?: string } | null)?.hint;
    console.log(`  ✓ ${label}\n      ${m}${h ? `\n      hint: ${h}` : ""}`);
  }
}

async function main() {
  process.env.COOKIE_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  const dca = await import("../src/core/dca");
  const { quoteAgg } = await import("../src/core/cookiebox");
  const { fetchJson } = await import("../src/core/http");
  const { COOKIEBOX_AGG_API_URL, DEFAULT_SLIPPAGE_BPS } = await import("../src/core/config");
  const { getConnection } = await import("../src/core/rpc");
  const { resolveMeta } = await import("../src/core/trade");
  const { priceFromAmounts, takingAmountForPrice } = await import("../src/core/limitOrders");
  const conn = getConnection();
  const { output: outMeta } = await resolveMeta(COOK, OUTPUT);
  const outDec = outMeta.dec;
  const owner = new PublicKey(OWNER);
  console.log(`== aggregator ${COOKIEBOX_AGG_API_URL}`);

  console.log(`== running schedules for ${OWNER}`);
  try {
    const list = await dca.getDcaSchedules({ owner: OWNER });
    console.log(`   ${list.count} schedule(s)`);
    for (const s of list.schedules) console.log("   ", JSON.stringify(s));
  } catch (e) {
    console.log(`   (listing refused) ${e instanceof Error ? e.message : e}`);
    if (/not switched on/.test(String(e))) {
      console.log(
        "   ↑ the flag is off on this aggregator — run against a local agg to go further",
      );
      return;
    }
    throw e;
  }

  console.log("== market rate for ONE SLICE via the same router a cycle fills with");
  const route = await quoteAgg(COOK, OUTPUT, PER_CYCLE_RAW.toString(), DEFAULT_SLIPPAGE_BPS, OWNER);
  if (!route) throw new Error("no route for the verification pair");
  const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
  const marketRate = priceFromAmounts(PER_CYCLE_RAW, marketOut, 9, outDec)!;
  console.log(
    `   0.0025 COOK → ${marketOut} raw ${outMeta.sym} (${outDec} dp) = ${marketRate} per COOK`,
  );

  // A floor 20% below the executable rate: a band a cycle can actually meet.
  const minPrice = (marketRate * 0.8).toFixed(9);
  const minOut = takingAmountForPrice(PER_CYCLE_RAW, minPrice, 9, outDec)!;
  const startAt = Math.floor(Date.now() / 1000) + 600;

  console.log("== open-tx: build via the agg, verify, simulate locally (not signed)");
  const built = await fetchJson<{
    transactionBase64: string;
    dca: string;
    reserve: string;
    cycles: number;
    minOut: string;
    makerFeeBps: number;
    wrappedLamports: string;
  }>(`${COOKIEBOX_AGG_API_URL}/dca/open-tx`, {
    method: "POST",
    body: JSON.stringify({
      owner: OWNER,
      inputMint: COOK,
      outputMint: OUTPUT,
      inDeposited: BUDGET_RAW.toString(),
      inAmountPerCycle: PER_CYCLE_RAW.toString(),
      cycleFrequency: CYCLE_SECONDS,
      minOut: minOut.toString(),
      startAt,
    }),
    timeoutMs: 60_000,
  });
  if (BigInt(built.minOut) !== minOut)
    throw new Error(`API minOut ${built.minOut} ≠ ours ${minOut}`);
  const expected = {
    owner,
    inputMint: new PublicKey(COOK),
    outputMint: new PublicKey(OUTPUT),
    inDeposited: BUDGET_RAW,
    inAmountPerCycle: PER_CYCLE_RAW,
    cycleFrequency: CYCLE_SECONDS,
    minOut,
    maxOut: 0n,
    startAt,
    refundNative: true, // COOK input, wrapSol default ⇒ the program pins our wallet for the refund
    payoutNative: false,
    dca: new PublicKey(built.dca),
  };
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
  dca.assertOpenTxTrustworthy(tx, expected);
  console.log(
    `   ✓ build verified: schedule ${built.dca}, reserve ${built.reserve}, ${built.cycles} cycles, ` +
      `fee ${built.makerFeeBps} bps, wraps ${built.wrappedLamports} lamports`,
  );
  const sim = await conn.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed",
  });
  if (sim.value.err) {
    console.log("   ✗ local simulation failed", JSON.stringify(sim.value.err));
    console.log((sim.value.logs ?? []).slice(-8).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`   ✓ local simulation ok (${sim.value.unitsConsumed} CU)`);
  }

  console.log("== tampered expectations against the SAME bytes are refused");
  await expectFailure("another user", async () =>
    dca.assertOpenTxTrustworthy(tx, { ...expected, owner: Keypair.generate().publicKey }),
  );
  await expectFailure("a band we did not ask for", async () =>
    dca.assertOpenTxTrustworthy(tx, { ...expected, minOut: minOut + 1n }),
  );
  await expectFailure("a start time we did not ask for", async () =>
    dca.assertOpenTxTrustworthy(tx, { ...expected, startAt: startAt + 1 }),
  );

  console.log("== client-side guards with an unfunded key (the configured wallet for this run)");
  const base = {
    inputMint: COOK,
    outputMint: OUTPUT,
    amount: "0.01",
    cycleSeconds: CYCLE_SECONDS,
  };
  await expectFailure("neither cycles nor amountPerCycle", () => dca.openDca({ ...base }));
  await expectFailure("both cycles and amountPerCycle", () =>
    dca.openDca({ ...base, cycles: 4, amountPerCycle: "0.0025" }),
  );
  await expectFailure("a slice larger than the budget", () =>
    dca.openDca({ ...base, amountPerCycle: "1" }),
  );
  await expectFailure("more cycles than the program allows", () =>
    dca.openDca({ ...base, cycles: 2_000 }),
  );
  await expectFailure("a sub-minute frequency", () =>
    dca.openDca({ ...base, cycles: 4, cycleSeconds: 30 }),
  );
  await expectFailure("a start time in the past (the program would fire at once)", () =>
    dca.openDca({ ...base, cycles: 4, startAt: Math.floor(Date.now() / 1000) - 60 }),
  );
  await expectFailure("a floor ABOVE the executable rate (every cycle would be skipped)", () =>
    dca.openDca({ ...base, cycles: 4, minPrice: (marketRate * 2).toFixed(9) }),
  );
  await expectFailure("minPrice above maxPrice", () =>
    dca.openDca({
      ...base,
      cycles: 4,
      minPrice: (marketRate * 0.9).toFixed(9),
      maxPrice: (marketRate * 0.5).toFixed(9),
    }),
  );
  await expectFailure("an unfunded wallet fails the agg's simulation with a sentence", () =>
    dca.openDca({ ...base, cycles: 4 }),
  );
  await expectFailure("closing a schedule we do not own", () =>
    dca.closeDca({ dca: Keypair.generate().publicKey.toBase58() }),
  );

  console.log(
    process.exitCode ? "❌ verify-dca: failures above" : "✅ verify-dca: all checks passed",
  );
}

main().catch((e) => {
  console.error("❌ verify-dca failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
