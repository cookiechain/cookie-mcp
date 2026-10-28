/**
 * Live, read-only check of the Ratchet integration against Cookie Chain — no key, nothing signed:
 *   - the deployed program is where the IDL says, and lists its RangeOrder accounts;
 *   - every open order decodes, its position + pool parse, and the keeper's next move is predicted;
 *   - the position-NFT lookup, payout-account and tick-array checks run on real accounts.
 * With COOKIE_PRIVATE_KEY set it also runs `get_ratchet_orders` for that wallet.
 *
 *   npx tsx scripts/verify-ratchet.ts
 */
import { PublicKey } from "@solana/web3.js";

import { RATCHET_KEEPER } from "../src/core/config";
import {
  decideRatchet,
  decodePositionNft,
  describeDecision,
  getRatchetOrders,
  listRangeOrders,
  parsePool,
  parsePosition,
  payoutAccounts,
  RATCHET_PROGRAM_ID,
  sqrtAt,
} from "../src/core/ratchet";
import { getConnection } from "../src/core/rpc";
import { ownPublicKey } from "../src/core/wallet";

async function main() {
  const conn = getConnection();
  const info = await conn.getAccountInfo(RATCHET_PROGRAM_ID);
  if (!info?.executable) throw new Error(`Ratchet program ${RATCHET_PROGRAM_ID} is not deployed`);
  console.log(`✅ Ratchet program ${RATCHET_PROGRAM_ID.toBase58()} is executable`);

  const all = await listRangeOrders(conn, null);
  console.log(`✅ ${all.length} open RangeOrder(s) on chain`);
  for (const { address, order } of all) {
    const [posInfo] = await conn.getMultipleAccountsInfo([order.position]);
    if (!posInfo) {
      console.log(
        `   ${address.toBase58()}: STALE (position ${order.position.toBase58()} is gone)`,
      );
      continue;
    }
    const position = parsePosition(order.position, posInfo);
    const pool = parsePool(order.whirlpool, await conn.getAccountInfo(order.whirlpool));
    const largest = await conn.getTokenLargestAccounts(order.positionMint);
    const holder = largest.value.find((a) => a.amount === "1");
    const nft = holder
      ? decodePositionNft(holder.address, (await conn.getAccountInfo(holder.address))!)
      : null;
    const [mintA, mintB] = await conn.getMultipleAccountsInfo([pool.tokenMintA, pool.tokenMintB]);
    const payout = payoutAccounts({
      order: address,
      owner: order.owner,
      mintA: pool.tokenMintA,
      mintB: pool.tokenMintB,
      tokenProgramA: mintA!.owner,
      tokenProgramB: mintB!.owner,
    });
    const atas = payout.ownerAtas.length
      ? await conn.getMultipleAccountsInfo(payout.ownerAtas.map((a) => a.address))
      : [];
    const decision = decideRatchet({
      direction: order.direction,
      minStep: order.minStep,
      tickSpacing: pool.tickSpacing,
      tickCurrent: pool.tickCurrentIndex,
      sqrtPrice: BigInt(pool.sqrtPrice.toString()),
      liquidity: BigInt(position.liquidity.toString()),
      lower: position.tickLowerIndex,
      upper: position.tickUpperIndex,
      sqrtAt,
    });
    console.log(
      `   ${address.toBase58()}: owner ${order.owner.toBase58()} ${order.direction} min_step ` +
        `${order.minStep} cranker ${order.cranker?.toBase58() === RATCHET_KEEPER ? "keeper" : (order.cranker?.toBase58() ?? "anyone")}`,
    );
    console.log(
      `     range [${position.tickLowerIndex}, ${position.tickUpperIndex}] tick ${pool.tickCurrentIndex} ` +
        `spacing ${pool.tickSpacing} L=${position.liquidity.toString()}`,
    );
    console.log(
      `     nft delegated: ${nft?.delegate?.equals(address) ? "yes" : "NO"}; payout accounts present: ` +
        `${atas.every(Boolean) ? "yes" : "NO"}`,
    );
    console.log(
      `     next: ${describeDecision(decision, { direction: order.direction, minStep: order.minStep, sold: order.direction === "aToB" ? "A" : "B", received: order.direction === "aToB" ? "B" : "A" })}`,
    );
  }

  const me = ownPublicKey();
  if (me) {
    const mine = await getRatchetOrders({});
    console.log(`✅ get_ratchet_orders for ${me}: ${mine.count} order(s)`);
    console.log(JSON.stringify(mine, null, 2));
  } else {
    // Exercise the full tool path on the first order's owner instead.
    const owner = all[0]?.order.owner ?? new PublicKey(RATCHET_KEEPER);
    const view = await getRatchetOrders({ owner: owner.toBase58() });
    console.log(`✅ get_ratchet_orders for ${owner.toBase58()}: ${view.count} order(s)`);
    console.log(JSON.stringify(view, null, 2));
  }
}

main().catch((e) => {
  console.error("❌ verify-ratchet failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
