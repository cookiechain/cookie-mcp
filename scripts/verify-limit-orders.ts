/**
 * Limit-order structural check against the LIVE Cookiebox aggregator — NOTHING IS SIGNED, NOTHING
 * IS SENT, NOTHING IS SPENT:
 *   npx tsx scripts/verify-limit-orders.ts
 *   OWNER=<funded pubkey> OUTPUT=<mint> npx tsx scripts/verify-limit-orders.ts
 *
 * `OWNER` is only a public key the aggregator builds FOR (its server-side simulation needs a wallet
 * that can actually cover the order); we never hold its secret. The script asks the API for a real
 * take-profit build and a real stop build, runs the same pre-sign verification `place_limit_order`
 * runs, and simulates both on our RPC with signature checks off. Then it flips to a freshly
 * generated (unfunded) key and proves the money paths stop at a guard before signing.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// A funded public wallet (the limit-order program admin), so the agg's simulation of a wrap+place passes.
const OWNER = process.env.OWNER?.trim() || "HGSGbiM3tMvbX8cxitEgzbQv53M4rFcsE1gn7fvrHrkN";
const COOK = "So11111111111111111111111111111111111111112";
const OUTPUT = process.env.OUTPUT?.trim() || "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL"; // MON
const AMOUNT_RAW = 10_000_000n; // 0.01 COOK

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
  const lo = await import("../src/core/limitOrders");
  const { quoteAgg } = await import("../src/core/cookiebox");
  const { fetchJson } = await import("../src/core/http");
  const { COOKIEBOX_AGG_API_URL, DEFAULT_SLIPPAGE_BPS } = await import("../src/core/config");
  const { getConnection } = await import("../src/core/rpc");
  const { resolveMeta } = await import("../src/core/trade");
  const conn = getConnection();
  const { output: outMeta } = await resolveMeta(COOK, OUTPUT);
  const outDec = outMeta.dec;
  const owner = new PublicKey(OWNER);

  console.log("== fees (null is expected while the deployed agg predates /limit-orders/fees)");
  console.log("  ", JSON.stringify(await lo.fetchLimitOrderFees()));

  console.log(`== open orders for ${OWNER}`);
  const list = await lo.getLimitOrders({ owner: OWNER });
  console.log(`   ${list.count} order(s)`);
  for (const o of list.orders) console.log("   ", JSON.stringify(o));

  console.log("== market rate via the same router the keeper fills with");
  const route = await quoteAgg(COOK, OUTPUT, AMOUNT_RAW.toString(), DEFAULT_SLIPPAGE_BPS, OWNER);
  if (!route) throw new Error("no route for the verification pair");
  const marketOut = BigInt(route.grossOutAmount ?? route.totalOutAmount);
  const marketRate = lo.priceFromAmounts(AMOUNT_RAW, marketOut, 9, outDec)!;
  console.log(
    `   0.01 COOK → ${marketOut} raw ${outMeta.sym} (${outDec} dp) = ${marketRate} per COOK`,
  );

  const builds: Array<{ label: string; kind: "limit" | "stop"; price: string }> = [
    { label: "take-profit at 3× market", kind: "limit", price: (marketRate * 3).toFixed(6) },
    { label: "stop with trigger at ½ market", kind: "stop", price: (marketRate / 2).toFixed(6) },
  ];
  for (const b of builds) {
    console.log(`== ${b.label}: build via the agg, verify, simulate locally (not signed)`);
    const expiredAt = Math.floor(Date.now() / 1000) + 3600;
    const built = await fetchJson<{
      transactionBase64: string;
      order: string;
      takingAmount: string;
      triggerTakingAmount: string | null;
      makerFeeBps: number;
      wrappedLamports: string;
      /** Absent on agg builds that predate the echo — which is why the core never trusts it. */
      refundNative?: boolean;
    }>(`${COOKIEBOX_AGG_API_URL}/limit-orders/place-tx`, {
      method: "POST",
      body: JSON.stringify({
        owner: OWNER,
        inputMint: COOK,
        outputMint: OUTPUT,
        makingAmount: AMOUNT_RAW.toString(),
        price: b.price,
        kind: b.kind,
        expiredAt,
      }),
      timeoutMs: 60_000,
    });
    const priced = lo.takingAmountForPrice(AMOUNT_RAW, b.price, 9, outDec)!;
    const takingAmount = BigInt(built.takingAmount);
    const trigger = BigInt(built.triggerTakingAmount ?? "0");
    if (b.kind === "limit" && takingAmount !== priced) {
      throw new Error(`API taking ${takingAmount} ≠ ours ${priced}`);
    }
    if (b.kind === "stop" && trigger !== priced) {
      throw new Error(`API trigger ${trigger} ≠ ours ${priced}`);
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionBase64, "base64"));
    lo.assertPlaceTxTrustworthy(tx, {
      owner,
      inputMint: new PublicKey(COOK),
      outputMint: new PublicKey(OUTPUT),
      makingAmount: AMOUNT_RAW,
      takingAmount,
      triggerTakingAmount: trigger,
      kind: b.kind,
      expiredAt,
      refundNative: true, // COOK input, wrapCook default ⇒ the program pins our wallet for the refund
      payoutNative: false,
      order: new PublicKey(built.order),
    });
    console.log(
      `   ✓ build verified: order ${built.order}, taking ${takingAmount}, trigger ${trigger}, ` +
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
    // Tamper: the same bytes with the fee payer swapped must be refused.
    const tampered = VersionedTransaction.deserialize(
      Buffer.from(built.transactionBase64, "base64"),
    );
    await expectFailure("tampered expectation (other maker) is refused", async () =>
      lo.assertPlaceTxTrustworthy(tampered, {
        owner: Keypair.generate().publicKey,
        inputMint: new PublicKey(COOK),
        outputMint: new PublicKey(OUTPUT),
        makingAmount: AMOUNT_RAW,
        takingAmount,
        triggerTakingAmount: trigger,
        kind: b.kind,
        expiredAt,
        refundNative: true,
        payoutNative: false,
        order: new PublicKey(built.order),
      }),
    );
  }

  console.log("== guards with an unfunded key (the configured wallet for this run)");
  await expectFailure("a take-profit priced below market is refused before the API", () =>
    lo.placeLimitOrder({
      inputMint: COOK,
      outputMint: OUTPUT,
      amount: "0.01",
      price: (marketRate / 2).toFixed(6),
    }),
  );
  await expectFailure("a stop triggered above market is refused before the API", () =>
    lo.placeLimitOrder({
      inputMint: COOK,
      outputMint: OUTPUT,
      amount: "0.01",
      price: (marketRate * 2).toFixed(6),
      kind: "stop",
    }),
  );
  await expectFailure("an unfunded wallet fails the agg's simulation with a sentence", () =>
    lo.placeLimitOrder({
      inputMint: COOK,
      outputMint: OUTPUT,
      amount: "0.01",
      price: (marketRate * 3).toFixed(6),
    }),
  );
  await expectFailure("floorPrice on a limit order is refused", () =>
    lo.placeLimitOrder({
      inputMint: COOK,
      outputMint: OUTPUT,
      amount: "0.01",
      price: (marketRate * 3).toFixed(6),
      floorPrice: "1",
    }),
  );
  await expectFailure("cancelling an order we do not own", () =>
    lo.cancelLimitOrder({ order: Keypair.generate().publicKey.toBase58() }),
  );
  console.log(
    process.exitCode
      ? "❌ verify-limit-orders: failures above"
      : "✅ verify-limit-orders: all checks passed",
  );
}

main().catch((e) => {
  console.error("❌ verify-limit-orders failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
