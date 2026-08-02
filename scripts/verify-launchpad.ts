/**
 * MomoSwap launchpad structural check with an UNFUNDED wallet (no funds spent):
 *   npx tsx scripts/verify-launchpad.ts
 *   BUYER=<funded pubkey> npx tsx scripts/verify-launchpad.ts   # simulation reaches the program
 * Expected: the read paths print live launchpad state (config-derived economics, pools, one pool
 * resolved BOTH by pool address and by token mint, a curve buy quote), and every money path stops
 * at a guard or at simulate — never a send. Live pools may be zero, in which case the trade guards
 * report the pool's real lifecycle state instead.
 *
 * The last section builds a real buy transaction server-side and simulates it, which exercises
 * deserialize → simulate → program-error translation against the deployed program. Pass `BUYER` (a
 * public key only — nothing is signed) so the simulation gets past the fee payer; without it the
 * simulation fails at the unfunded payer instead of reaching the program's validation.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

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
  const lp = await import("../src/core/launchpad");

  console.log("Reads:");
  const all = await lp.getLaunchpadPools({ status: "all", limit: 5 });
  console.log(`  ✓ get_launchpad_pools(all): ${all.count} pools, program ${all.program}`);
  for (const p of all.pools) {
    console.log(
      `      ${p.symbol.padEnd(10)} ${p.status.padEnd(9)} ${p.graduationProgressPct}% of ` +
        `${p.graduationTargetCook} COOK  price ${p.priceCook.toPrecision(4)}  ${p.mint}`,
    );
  }
  const live = await lp.getLaunchpadPools({ status: "live" });
  console.log(`  ✓ get_launchpad_pools(live): ${live.count} tradeable now`);

  const sample = all.pools[0];
  if (!sample) throw new Error("no launchpad pools returned — cannot continue");

  const byPool = await lp.getLaunchpadToken({ ref: sample.pool });
  console.log(
    `  ✓ get_launchpad_token(by pool): ${byPool.symbol} ${byPool.status}, raised ${byPool.raisedCook} COOK, ` +
      `fee ${byPool.fees.tradePct}% (creator ${byPool.fees.creatorSharePct}% of it)`,
  );
  const byMint = await lp.getLaunchpadToken({ ref: sample.mint, quoteCook: 1 });
  console.log(
    `  ✓ get_launchpad_token(by mint): resolves to the same pool = ${byMint.pool === byPool.pool}` +
      (byMint.quote
        ? `, 1 COOK → ~${byMint.quote.tokensOut} ${byMint.symbol}`
        : ", no quote (not live)"),
  );
  for (const n of byMint.notes) console.log(`      note: ${n}`);

  // Portfolio read: batched UserPosition PDAs, not one HTTP call per pool. 9rj5GEEy… is the wallet
  // that created and traded most of the rehearsal pools, so it exercises both sections.
  const KNOWN_TRADER = "9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni";
  const port = await lp.getLaunchpadPositions({ owner: KNOWN_TRADER });
  console.log(
    `  ✓ get_launchpad_positions(${KNOWN_TRADER.slice(0, 6)}…): ${port.positions.length} position(s) + ` +
      `${port.created.length} created, across ${port.poolsScanned} pools scanned; ` +
      `invested ${port.totals.investedCook} / withdrawn ${port.totals.withdrawnCook} COOK, ` +
      `${port.totals.actionsPending} action(s) pending`,
  );
  for (const p of port.positions.slice(0, 5)) {
    console.log(
      `      ${p.symbol.padEnd(10)} ${p.status.padEnd(9)} shares ${p.shares.padEnd(14)} ` +
        `in ${p.investedCook.padEnd(8)} out ${p.withdrawnCook.padEnd(10)} ` +
        (p.action ? `→ ${p.action.tool} (${p.action.kind})` : "settled"),
    );
  }
  for (const c of port.created.slice(0, 5)) {
    console.log(
      `      created ${c.symbol.padEnd(10)} unclaimed fees ${c.unclaimedFeesCook} COOK` +
        (c.unclaimedVestTokens ? `, vest ${c.unclaimedVestTokens} ${c.symbol}` : "") +
        (c.actions.length ? ` → ${c.actions.map((a) => a.tool).join(" + ")}` : ""),
    );
  }
  const empty = await lp.getLaunchpadPositions({ owner: Keypair.generate().publicKey.toBase58() });
  console.log(
    `  ✓ get_launchpad_positions(fresh wallet): ${empty.positions.length} positions — "${empty.notes[0]}"`,
  );

  console.log("\nGuards (unfunded wallet, nothing sent):");
  await expectFailure("deploy_token with no logo and no explicit opt-out", () =>
    lp.deployToken({ name: "Verify", symbol: "VRFY" }),
  );
  await expectFailure("deploy_token with a bad duration", () =>
    lp.deployToken({ name: "Verify", symbol: "VRFY", durationSecs: 10 }),
  );
  await expectFailure("launchpad_buy on an unknown pool", () =>
    lp.launchpadBuy({ ref: Keypair.generate().publicKey.toBase58(), amountCook: 1 }),
  );
  await expectFailure(`launchpad_buy on ${sample.symbol} (${sample.status})`, () =>
    lp.launchpadBuy({ ref: sample.pool, amountCook: 1 }),
  );
  await expectFailure(`launchpad_sell on ${sample.symbol} with no position`, () =>
    lp.launchpadSell({ ref: sample.pool, shares: 1 }),
  );
  await expectFailure(`claim_launchpad on ${sample.symbol}`, () =>
    lp.claimLaunchpad({ ref: sample.pool }),
  );
  await expectFailure("claim_creator_fees as a non-creator", () =>
    lp.claimCreatorFees({ ref: sample.pool }),
  );

  // Prove the real build → deserialize → simulate chain against the live program, without sending
  // and without consuming a launchpad resource: a buy on a non-live pool builds fine server-side and
  // must fail *on-chain* validation, which also exercises the program-error translation.
  console.log("\nBuild + simulate against the live program (nothing sent):");
  const { buildBuyTx } = await import("../src/core/launchpad/api");
  const { getConnection } = await import("../src/core/rpc");
  const { Transaction } = await import("@solana/web3.js");
  // A funded buyer (public key only — nothing is signed here) lets the simulation get past the fee
  // payer and reach the program's own validation. `BUYER` may be any funded Cookie Chain address.
  const buyer = process.env.BUYER?.trim() || Keypair.generate().publicKey.toBase58();
  const built = await buildBuyTx({ buyer, pool: sample.pool, paymentAmount: "1000000" });
  console.log(
    `  ✓ POST /tx/buy returned a partial-signed tx (${built.transactionBase64.length} b64 chars), ` +
      `blockhash ${built.blockhash.slice(0, 8)}…`,
  );
  const tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
  console.log(`  ✓ deserialized: ${tx.instructions.length} instructions, feePayer set`);
  const sim = await getConnection().simulateTransaction(tx);
  if (!sim.value.err) {
    console.log(`  ✗ expected the simulation to fail on a ${sample.status} pool, but it succeeded`);
  } else {
    const e = lp.launchpadSimError("buy", sim.value.err, sim.value.logs ?? null);
    console.log(`  ✓ simulation failed and was translated\n      ${e.message}`);
  }
}

main().catch((e) => {
  console.error("❌ verify-launchpad failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
