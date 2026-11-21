// Live, read-only check of the Dice Club tools: reads the table, quotes a bet, lists a wallet's bets,
// and simulates (never sends) a `place_bet` for a club member. No key needed.
//   npx tsx scripts/verify-dice.ts [memberWallet]   (default: the player of the latest settled bet)
import { PublicKey } from "@solana/web3.js";

import {
  betAddress,
  buildPlaceBetTx,
  decodeHouse,
  diceErrorOf,
  diceProgram,
  findClubPass,
  getDiceBets,
  getDiceTable,
  houseAddress,
  decodeGate,
  gateAddress,
  parseResolvedEvents,
} from "../src/core/dice";
import { getConnection } from "../src/core/rpc";

/** The latest settled bet on the house: proves the event parser on a real log, and names a member. */
async function latestSettle(): Promise<{
  player: string;
  nonce: bigint;
  signature: string;
} | null> {
  const conn = getConnection();
  for (const s of await conn.getSignaturesForAddress(houseAddress(), { limit: 25 })) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    const ev = parseResolvedEvents(tx?.meta?.logMessages ?? []).find((e) => !e.expired);
    if (ev) return { player: ev.player, nonce: ev.nonce, signature: s.signature };
  }
  return null;
}

async function main() {
  const latest = await latestSettle();
  console.log("latest settle:", latest);
  const member = process.argv[2] ?? latest?.player;
  console.log(
    JSON.stringify(await getDiceTable({ chance: 50, amount: 1, wallet: member }), null, 2),
  );
  if (!member) return;
  console.log(JSON.stringify(await getDiceBets({ wallet: member }), null, 2));
  if (latest && member === latest.player) {
    console.log(
      JSON.stringify(
        await getDiceBets({ wallet: member, nonce: latest.nonce.toString() }),
        null,
        2,
      ),
    );
  }

  const conn = getConnection();
  const player = new PublicKey(member);
  const [h, g] = await conn.getMultipleAccountsInfo([houseAddress(), gateAddress()]);
  const house = decodeHouse(h!.data);
  const gate = decodeGate(g!.data);
  const pass = await findClubPass(conn, player, gate.collection);
  console.log("pass:", pass?.name ?? null);
  for (const withPass of [true, false]) {
    const tx = await buildPlaceBetTx(diceProgram(conn), {
      player,
      nonce: house.nextNonce,
      amount: house.minBetLamports,
      target: 5000,
      clientSeed: Buffer.alloc(32, 7),
      pass: withPass ? pass : null,
    });
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = player;
    const sim = await conn.simulateTransaction(tx);
    console.log(
      `simulate place_bet (${withPass ? "with" : "without"} pass, bet ${betAddress(player, house.nextNonce).toBase58()}):`,
      sim.value.err
        ? (diceErrorOf(sim.value.err, sim.value.logs ?? [])?.name ?? sim.value.err)
        : "OK",
      `${sim.value.unitsConsumed} CU`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
