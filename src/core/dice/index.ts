// Dice Club — provably fair on-chain dice (`get_dice_table`, `roll_dice`, `get_dice_bets`,
// `refund_dice_bet`).
//
// Pick a win chance, stake COOK, win if the roll (0.00–99.99) lands under it. A win pays
// `stake × (100% − edge) / chance`, so the expected return is the same at every chance. The program
// holds the money and the rules; the house's keeper only reveals seeds:
//   - the house committed to a reverse SHA-256 seed chain up front (one 32-byte head on chain), so it
//     cannot pick a seed after seeing a bet;
//   - the player's own client seed goes into every roll — this server generates it locally (random
//     unless the caller passes one), so the house cannot know a roll before the bet lands;
//   - bets settle strictly in placement order, so a revealed seed cannot be steered to a bet.
// `roll_dice` re-derives every roll from the revealed seed before reporting it (`proof.verified`).
// A keeper that fails to settle within the deadline (~24 h) owes a stake refund, which anyone —
// `refund_dice_bet` here — can claim.
//
// Members only: while the program's gate is on, only a wallet holding a verified NFT of the gate's
// collection (Cookie Chads) may bet. Settling and refunds are never gated.
import { PublicKey, type Connection } from "@solana/web3.js";

import { COOK_DECIMALS, DICE_CLUB_SITE_URL, explorerAddressUrl, explorerTxUrl } from "../config";
import { resolveWallet } from "../domains";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw } from "../format";
import { signSendConfirm } from "../liquidity/send";
import { getConnection } from "../rpc";
import { ownPublicKey, requireSigner } from "../wallet";
import { findClubPass, type ClubPass } from "./club";
import {
  chanceToTarget,
  checkBet,
  clientSeedFrom,
  formatRoll,
  freeBankroll,
  MAX_PENDING,
  maxStakeForTarget,
  maxTargetForEdge,
  multiplier,
  targetToChance,
  verifyRoll,
  type BetCheck,
  type HouseRules,
} from "./math";
import {
  betAddress,
  buildExpireBetTx,
  buildPlaceBetTx,
  decodeBet,
  decodeGate,
  decodeHouse,
  diceErrorOf,
  diceProgram,
  DICE_PROGRAM_ID,
  fetchPlayerBets,
  gateAddress,
  houseAddress,
  parseResolvedEvents,
  vaultAddress,
  type Bet,
  type Gate,
  type House,
  type ResolvedEvent,
} from "./program";

export * from "./club";
export * from "./math";
export * from "./program";

export const DICE_NAME = "Dice Club";

/** Cookie Chain slot time, measured (2026-11-15) — only for turning slot counts into rough times. */
export const SECONDS_PER_SLOT = 0.456;
/** Left in the wallet on top of the stake for fees, as the Dice Club site does. */
export const FEE_RESERVE_LAMPORTS = 5_000_000n;
/** `Bet` account size (8 discriminator + `InitSpace`); its rent is paid at placement and refunded on close. */
export const BET_ACCOUNT_BYTES = 139;
/** Default and ceiling for how long `roll_dice` waits for the keeper. */
export const DEFAULT_WAIT_SECONDS = 45;
export const MAX_WAIT_SECONDS = 120;
const POLL_MS = 1_500;

const cook = (lamports: bigint) => rawToUi(lamports, COOK_DECIMALS);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers ---------------------------------------------------------------------------------

export function rulesOf(house: House): HouseRules {
  return {
    edgeBps: house.edgeBps,
    minBetLamports: house.minBetLamports,
    maxPayoutBps: house.maxPayoutBps,
  };
}

/** Why `place_bet` would refuse, as an actionable error. */
export function refusalError(check: BetCheck, rules: HouseRules, target: number): CookieMcpError {
  const maxChance = targetToChance(maxTargetForEdge(rules.edgeBps));
  switch (check.reason) {
    case "paused":
      return new CookieMcpError(
        "the Dice Club table is paused",
        "the house paused betting; try later",
      );
    case "table-stalled":
      return new CookieMcpError(
        `the table is closed: ${MAX_PENDING} bets are already waiting for the keeper`,
        "the keeper is behind (or down) — try again in a minute; waiting bets settle by their real roll",
      );
    case "stake-below-minimum":
      return new CookieMcpError(
        `stake is below the table minimum of ${cook(rules.minBetLamports)} COOK`,
        `stake at least ${cook(rules.minBetLamports)} COOK`,
      );
    case "target-out-of-range":
      return new CookieMcpError(
        `chance must be between 0.01% and ${maxChance}%`,
        `past ${maxChance}% a win would pay no more than the stake at the ${Number(rules.edgeBps) / 100}% edge`,
      );
    case "exceeds-bankroll":
      return new CookieMcpError(
        `a win at ${targetToChance(target)}% would pay more than the bankroll allows for one bet`,
        check.maxStake > 0n
          ? `the most the table takes at ${targetToChance(target)}% right now is ${cook(check.maxStake)} COOK — lower the stake or raise the chance`
          : `the bankroll cannot cover even the minimum stake at ${targetToChance(target)}% — raise the chance`,
      );
    default:
      return new CookieMcpError("the table refused the bet");
  }
}

/** Roughly how long until `deadlineSlot`, in whole minutes (0 when past). */
export function minutesUntil(deadlineSlot: bigint, slot: bigint): number {
  return deadlineSlot <= slot
    ? 0
    : Math.ceil((Number(deadlineSlot - slot) * SECONDS_PER_SLOT) / 60);
}

/** A pending bet, as the agent sees it. */
export function describePendingBet(bet: Bet, house: House | null, slot: bigint) {
  const ahead = house ? bet.nonce - house.settledNonce : null;
  const pastDeadline = slot >= bet.deadlineSlot;
  const refundable = pastDeadline && ahead === 0n;
  return {
    status: "pending" as const,
    nonce: bet.nonce.toString(),
    bet: bet.address.toBase58(),
    stake: cook(bet.amount),
    chance: targetToChance(bet.target),
    payoutIfWon: cook(bet.payout),
    clientSeed: hex(bet.clientSeed),
    betsAhead: ahead === null ? null : Number(ahead),
    refundable,
    deadlineSlot: bet.deadlineSlot.toString(),
    note: refundable
      ? "past its deadline and first in line — refund_dice_bet returns the stake"
      : pastDeadline
        ? `past its deadline; ${ahead} older bet(s) must be resolved first (anyone can refund the oldest)`
        : `waiting for the keeper to settle it; refundable in ~${minutesUntil(bet.deadlineSlot, slot)} min if it never does`,
  };
}

/** A resolved bet (from its `BetResolved` event), re-verified from the revealed seed. */
export function describeResolution(
  ev: ResolvedEvent,
  signature: string,
  opts: { expectedClientSeed?: Buffer; winPayout?: bigint } = {},
) {
  const nonce = ev.nonce.toString();
  const base = {
    nonce,
    bet: betAddress(new PublicKey(ev.player), ev.nonce).toBase58(),
    stake: cook(ev.amount),
    chance: targetToChance(ev.target),
    signature,
    explorer: explorerTxUrl(signature),
  };
  if (ev.expired) {
    return {
      status: "refunded" as const,
      ...base,
      paid: cook(ev.paid),
      net: "0",
      note: "the house missed the settlement deadline, so the stake was refunded (no roll)",
    };
  }
  const check = verifyRoll({
    serverSeed: ev.serverSeed,
    clientSeed: ev.clientSeed,
    commitment: ev.commitment,
    nonce: ev.nonce,
    target: ev.target,
    roll: ev.roll,
    won: ev.won,
    paid: ev.paid,
    winPayout: opts.winPayout,
  });
  const clientSeedMatches = opts.expectedClientSeed
    ? opts.expectedClientSeed.equals(ev.clientSeed)
    : null;
  const verified = check.revealValid && check.matchesChain && clientSeedMatches !== false;
  const net = ev.won ? ev.paid - ev.amount : -ev.amount;
  const verifyUrl =
    `${DICE_CLUB_SITE_URL}/fairness?commitment=${hex(ev.commitment)}&server=${hex(ev.serverSeed)}` +
    `&client=${hex(ev.clientSeed)}&nonce=${nonce}&target=${ev.target}`;
  return {
    status: (ev.won ? "won" : "lost") as "won" | "lost",
    ...base,
    roll: formatRoll(check.roll),
    rollUnder: formatRoll(ev.target),
    paid: cook(ev.paid),
    net: `${net >= 0n ? "+" : "-"}${cook(net >= 0n ? net : -net)}`,
    proof: {
      verified,
      revealOpensCommitment: check.revealValid,
      rollRederived: check.matchesChain,
      ...(clientSeedMatches === null ? {} : { clientSeedIsOurs: clientSeedMatches }),
      serverSeed: hex(ev.serverSeed),
      clientSeed: hex(ev.clientSeed),
      commitment: hex(ev.commitment),
      placementCommitment: hex(ev.placementCommitment),
      seedIndex: ev.seedIndex.toString(),
      formula:
        "roll = be_u64(hmac_sha256(serverSeed, clientSeed || nonce_le)[0..8]) % 10000; win if roll < chance×100",
      verifyUrl,
    },
    ...(verified
      ? {}
      : {
          warning:
            "this roll did NOT verify against the revealed seed — the house's published result does not match the proof; keep the signature",
        }),
  };
}

// --- chain reads ----------------------------------------------------------------------------------

interface TableState {
  house: House;
  gate: Gate | null;
  vault: bigint;
  free: bigint;
  pending: bigint;
  slot: bigint;
}

async function loadTable(conn: Connection): Promise<TableState> {
  const [infos, rent0, slot] = await Promise.all([
    conn.getMultipleAccountsInfo([houseAddress(), gateAddress(), vaultAddress()], "confirmed"),
    conn.getMinimumBalanceForRentExemption(0, "confirmed"),
    conn.getSlot("confirmed"),
  ]);
  const [houseInfo, gateInfo, vaultInfo] = infos;
  if (!houseInfo || !houseInfo.owner.equals(DICE_PROGRAM_ID)) {
    throw new CookieMcpError(
      "the Dice Club house account was not found",
      "the table is not open (or the RPC is behind); check chain_health and retry",
    );
  }
  const house = decodeHouse(houseInfo.data);
  const gate =
    gateInfo && gateInfo.owner.equals(DICE_PROGRAM_ID) ? decodeGate(gateInfo.data) : null;
  const vault = BigInt(vaultInfo?.lamports ?? 0);
  return {
    house,
    gate,
    vault,
    free: freeBankroll(vault, house.lockedLiability, BigInt(rent0)),
    pending: house.nextNonce - house.settledNonce,
    slot: BigInt(slot),
  };
}

async function fetchBet(conn: Connection, address: PublicKey): Promise<Bet | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info || !info.owner.equals(DICE_PROGRAM_ID)) return null;
  return decodeBet(address, info.data);
}

/**
 * How a closed bet resolved. Settles and refunds both name the bet account, so its signature list is
 * short (place + resolve) — but the Cookie Chain RPC keeps only ~11 days of ledger, so an older bet
 * returns null.
 */
async function findResolution(
  conn: Connection,
  player: PublicKey,
  nonce: bigint,
): Promise<{ event: ResolvedEvent; signature: string } | null> {
  const sigs = await conn.getSignaturesForAddress(
    betAddress(player, nonce),
    { limit: 20 },
    "confirmed",
  );
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages || tx.meta.err) continue;
    const ev = parseResolvedEvents(tx.meta.logMessages).find(
      (e) => e.player === player.toBase58() && e.nonce === nonce,
    );
    if (ev) return { event: ev, signature: s.signature };
  }
  return null;
}

async function playerFor(
  wallet: string | undefined,
  what: string,
): Promise<{ pk: PublicKey; name?: string }> {
  if (wallet) {
    const r = await resolveWallet(wallet, "wallet");
    return { pk: r.pubkey, ...(r.name ? { name: r.name } : {}) };
  }
  const own = ownPublicKey();
  if (!own) {
    throw new CookieMcpError(
      "no wallet configured and no wallet given",
      `pass \`wallet\` (address or .cook name), or set COOKIE_PRIVATE_KEY to ${what}`,
    );
  }
  return { pk: new PublicKey(own) };
}

function parseStake(amount: string | number): bigint {
  try {
    const raw = uiToRaw(amount, COOK_DECIMALS);
    if (raw <= 0n) throw new Error("zero");
    return raw;
  } catch {
    throw new CookieMcpError(
      `invalid stake: ${String(amount)}`,
      'pass the stake in COOK, e.g. amount: 1 or amount: "2.5"',
    );
  }
}

function membershipHint(gate: Gate): string {
  return (
    `Dice Club is members-only: hold a verified NFT of collection ${gate.collection.toBase58()} ` +
    `(Cookie Chads) in this wallet — get_nft_listings with that collection lists ones for sale on Baked Bazaar`
  );
}

// --- tools ----------------------------------------------------------------------------------------

const PRESET_CHANCES = [10, 25, 50, 75, 90];

/** `get_dice_table`: the house's rules, bankroll and limits, plus whether a wallet may play. */
export async function getDiceTable(args: {
  wallet?: string;
  chance?: string | number;
  amount?: string | number;
}) {
  const conn = getConnection();
  const t = await loadTable(conn);
  const rules = rulesOf(t.house);
  const maxTarget = maxTargetForEdge(rules.edgeBps);
  const quoteAt = (target: number) => ({
    chance: targetToChance(target),
    multiplier: multiplier(target, rules.edgeBps),
    maxStake: cook(maxStakeForTarget(rules, t.free, target)),
  });

  let quote: Record<string, unknown> | undefined;
  if (args.chance !== undefined) {
    const target = chanceToTarget(args.chance);
    quote =
      target >= 1 && target <= maxTarget
        ? quoteAt(target)
        : { chance: targetToChance(target), error: `outside 0.01–${targetToChance(maxTarget)}%` };
    if (args.amount !== undefined && target >= 1 && target <= maxTarget) {
      const stake = parseStake(args.amount);
      const check = checkBet(
        rules,
        { paused: t.house.paused, pending: t.pending, free: t.free },
        stake,
        target,
      );
      quote = {
        ...quote,
        stake: cook(stake),
        payoutIfWon: cook(check.payout),
        profitIfWon: cook(check.profit),
        accepted: check.ok,
        ...(check.ok ? {} : { refusal: refusalError(check, rules, target).message }),
      };
    }
  }

  let player: Record<string, unknown> | undefined;
  const who = args.wallet ?? ownPublicKey() ?? undefined;
  if (who) {
    const p = await playerFor(who, "check your own membership");
    const [balance, pass] = await Promise.all([
      conn.getBalance(p.pk, "confirmed"),
      t.gate?.enabled ? findClubPass(conn, p.pk, t.gate.collection) : Promise.resolve(null),
    ]);
    player = {
      wallet: p.pk.toBase58(),
      ...(p.name ? { name: p.name } : {}),
      balance: cook(BigInt(balance)),
      canPlay: !t.gate?.enabled || pass !== null,
      ...(t.gate?.enabled
        ? { pass: pass ? { mint: pass.mint.toBase58(), name: pass.name } : null }
        : {}),
      ...(t.gate?.enabled && !pass ? { hint: membershipHint(t.gate) } : {}),
    };
  }

  const open = !t.house.paused && t.pending < MAX_PENDING && t.gate !== null;
  return {
    venue: DICE_NAME,
    site: DICE_CLUB_SITE_URL,
    program: DICE_PROGRAM_ID.toBase58(),
    open,
    paused: t.house.paused,
    membersOnly: t.gate?.enabled ?? null,
    ...(t.gate ? { clubCollection: t.gate.collection.toBase58() } : {}),
    rules: {
      houseEdge: `${Number(rules.edgeBps) / 100}%`,
      minStake: cook(rules.minBetLamports),
      chanceRange: `0.01–${targetToChance(maxTarget)}%`,
      maxProfitPerBet: cook((t.free * rules.maxPayoutBps) / 10_000n),
      maxProfitShareOfBankroll: `${Number(rules.maxPayoutBps) / 100}%`,
      refundAfterMinutes: Math.round((Number(t.house.settleTimeoutSlots) * SECONDS_PER_SLOT) / 60),
      payout: "stake × (100 − edge) / chance — the same expected return at every chance",
    },
    bankroll: {
      vault: cook(t.vault),
      owedToPendingBets: cook(t.house.lockedLiability),
      free: cook(t.free),
    },
    queue: {
      pending: Number(t.pending),
      closesAt: Number(MAX_PENDING),
      ...(t.pending >= MAX_PENDING
        ? { note: "table closed until the keeper settles the waiting bets" }
        : {}),
    },
    limits: PRESET_CHANCES.filter((c) => c * 100 <= maxTarget).map((c) => quoteAt(c * 100)),
    ...(quote ? { quote } : {}),
    ...(player ? { player } : {}),
    fairness: {
      seedCommitment: hex(t.house.seedCommitment),
      seedsRevealed: t.house.seedIndex.toString(),
      totalBets: t.house.totalBets.toString(),
      totalWagered: cook(t.house.totalWagered),
      totalPaid: cook(t.house.totalPaid),
      refundedBets: t.house.expiredCount.toString(),
    },
  };
}

/** `roll_dice`: place a bet, wait for the keeper, verify the roll. */
export async function rollDice(args: {
  amount: string | number;
  chance: string | number;
  clientSeed?: string;
  waitSeconds?: number;
}) {
  const signer = requireSigner();
  const player = signer.publicKey;
  const conn = getConnection();
  const program = diceProgram(conn);
  const stake = parseStake(args.amount);
  const target = chanceToTarget(args.chance);
  const clientSeed = clientSeedFrom(args.clientSeed);

  let t = await loadTable(conn);
  const rules = rulesOf(t.house);
  const check = checkBet(
    rules,
    { paused: t.house.paused, pending: t.pending, free: t.free },
    stake,
    target,
  );
  if (!check.ok) throw refusalError(check, rules, target);
  if (!t.gate) {
    throw new CookieMcpError(
      "the Dice Club table is not open yet (no gate account)",
      "try again later",
    );
  }

  const gate = t.gate;
  let pass: ClubPass | null = null;
  if (gate.enabled) {
    pass = await findClubPass(conn, player, gate.collection);
    if (!pass) {
      throw new CookieMcpError(
        `wallet ${player.toBase58()} holds no Dice Club pass`,
        membershipHint(gate),
      );
    }
  }

  const [balance, betRent] = await Promise.all([
    conn.getBalance(player, "confirmed"),
    conn.getMinimumBalanceForRentExemption(BET_ACCOUNT_BYTES, "confirmed"),
  ]);
  const needed = stake + BigInt(betRent) + FEE_RESERVE_LAMPORTS;
  if (BigInt(balance) < needed) {
    throw new CookieMcpError(
      `not enough COOK: the bet needs ${cook(needed)} COOK (stake + ${cook(BigInt(betRent))} refundable bet rent + fees), the wallet has ${cook(BigInt(balance))}`,
      "lower the stake or fund the wallet",
    );
  }

  // The bet PDA is keyed by the house's next nonce; if someone else bets between our read and our
  // send, ours collides on `init` (never lands on the wrong account) — re-read and rebuild.
  let nonce = t.house.nextNonce;
  let placeSig: string | null = null;
  for (let attempt = 0; attempt < 3 && !placeSig; attempt++) {
    if (attempt > 0) {
      t = await loadTable(conn);
      nonce = t.house.nextNonce;
      const again = checkBet(
        rulesOf(t.house),
        { paused: t.house.paused, pending: t.pending, free: t.free },
        stake,
        target,
      );
      if (!again.ok) throw refusalError(again, rulesOf(t.house), target);
    }
    const tx = await buildPlaceBetTx(program, {
      player,
      nonce,
      amount: stake,
      target,
      clientSeed,
      pass,
    });
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = player;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      if (/already in use/i.test(logs.join(" "))) continue;
      const de = diceErrorOf(sim.value.err, logs);
      if (de?.name === "NotAClubMember")
        throw new CookieMcpError("the program refused the club pass", membershipHint(gate));
      if (de) throw new CookieMcpError(`the table refused the bet: ${de.name}`, de.hint);
      throw new CookieMcpError(
        `simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
        "nothing was sent; check get_dice_table and your balance",
      );
    }
    placeSig = await signSendConfirm(conn, tx, signer, [], "dice bet", {
      summary: {
        action: "place a Dice Club bet",
        stake: `${cook(stake)} COOK`,
        chance: `${targetToChance(target)}%`,
        payoutIfWon: `${cook(check.payout)} COOK`,
        nonce: nonce.toString(),
        bet: betAddress(player, nonce).toBase58(),
        clientSeed: hex(clientSeed),
        after: `once it lands the house's keeper settles it within seconds — get_dice_bets with nonce ${nonce} shows the verified roll`,
      },
    });
  }
  if (!placeSig) {
    throw new CookieMcpError(
      "the table was busy: three attempts collided with other players' bets",
      "nothing was placed; try again",
    );
  }

  const placed = {
    nonce: nonce.toString(),
    bet: betAddress(player, nonce).toBase58(),
    stake: cook(stake),
    chance: targetToChance(target),
    payoutIfWon: cook(check.payout),
    placeSignature: placeSig,
    placeExplorer: explorerTxUrl(placeSig),
    ...(pass ? { pass: pass.name } : {}),
  };

  const waitMs =
    Math.min(Math.max(args.waitSeconds ?? DEFAULT_WAIT_SECONDS, 0), MAX_WAIT_SECONDS) * 1000;
  const deadline = Date.now() + waitMs;
  const betPda = betAddress(player, nonce);
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (await fetchBet(conn, betPda)) continue;
    const found = await findResolution(conn, player, nonce);
    if (found) {
      return {
        ...describeResolution(found.event, found.signature, {
          expectedClientSeed: clientSeed,
          winPayout: check.payout,
        }),
        placeSignature: placeSig,
        placeExplorer: explorerTxUrl(placeSig),
      };
    }
  }
  return {
    status: "pending" as const,
    ...placed,
    clientSeed: hex(clientSeed),
    note:
      waitMs === 0
        ? `placed; get_dice_bets with nonce ${nonce} shows the roll once the keeper settles it`
        : `placed, but the keeper had not settled it after ${waitMs / 1000}s — get_dice_bets with nonce ${nonce} shows the roll later. If it is never settled it becomes refundable (refund_dice_bet) after the deadline`,
  };
}

/** `get_dice_bets`: one bet by nonce (pending or its verified result), or every pending bet. */
export async function getDiceBets(args: { wallet?: string; nonce?: string | number }) {
  const conn = getConnection();
  const p = await playerFor(args.wallet, "list your own bets");
  const wallet = { wallet: p.pk.toBase58(), ...(p.name ? { name: p.name } : {}) };
  const [houseInfo, slot] = await Promise.all([
    conn.getAccountInfo(houseAddress(), "confirmed"),
    conn.getSlot("confirmed"),
  ]);
  const house = houseInfo ? decodeHouse(houseInfo.data) : null;

  if (args.nonce !== undefined) {
    const s = String(args.nonce).trim();
    if (!/^\d+$/.test(s)) {
      throw new CookieMcpError(
        `nonce must be a whole number, got ${s}`,
        "use the nonce roll_dice returned",
      );
    }
    const nonce = BigInt(s);
    const bet = await fetchBet(conn, betAddress(p.pk, nonce));
    if (bet) return { ...wallet, ...describePendingBet(bet, house, BigInt(slot)) };
    const found = await findResolution(conn, p.pk, nonce);
    if (found) return { ...wallet, ...describeResolution(found.event, found.signature) };
    throw new CookieMcpError(
      `no bet ${nonce} found for ${p.pk.toBase58()}`,
      "it was never placed by this wallet, or it resolved more than ~11 days ago (beyond the RPC's ledger) — " +
        `its record is on ${explorerAddressUrl(betAddress(p.pk, nonce).toBase58())}`,
    );
  }

  const bets = await fetchPlayerBets(conn, p.pk);
  return {
    ...wallet,
    pending: bets.map((b) => describePendingBet(b, house, BigInt(slot))),
    note: bets.length
      ? "settled bets drop off this list; pass `nonce` to see one's verified result"
      : "no pending bets; pass `nonce` to look up a settled one",
  };
}

/** `refund_dice_bet`: take the stake back from a bet the keeper failed to settle by its deadline. */
export async function refundDiceBet(args: { nonce: string | number }) {
  const signer = requireSigner();
  const conn = getConnection();
  const s = String(args.nonce).trim();
  if (!/^\d+$/.test(s)) {
    throw new CookieMcpError(
      `nonce must be a whole number, got ${s}`,
      "get_dice_bets lists your pending bets",
    );
  }
  const nonce = BigInt(s);
  const [bet, t] = await Promise.all([
    fetchBet(conn, betAddress(signer.publicKey, nonce)),
    loadTable(conn),
  ]);
  if (!bet) {
    throw new CookieMcpError(
      `no pending bet ${nonce} for ${signer.publicKey.toBase58()}`,
      "it was already settled or refunded — get_dice_bets with that nonce shows how",
    );
  }
  if (t.house.settledNonce !== bet.nonce) {
    throw new CookieMcpError(
      `bet ${nonce} is not first in line: ${bet.nonce - t.house.settledNonce} older bet(s) must be resolved first`,
      "bets resolve strictly in order; the older ones become refundable at their own deadlines",
    );
  }
  if (t.slot < bet.deadlineSlot) {
    throw new CookieMcpError(
      `bet ${nonce} is not past its deadline yet (~${minutesUntil(bet.deadlineSlot, t.slot)} min left)`,
      "the keeper may still settle it by its real roll; a refund is only possible after the deadline",
    );
  }
  const tx = await buildExpireBetTx(diceProgram(conn), signer.publicKey, bet);
  const signature = await signSendConfirm(conn, tx, signer, [], "dice refund", {
    summary: {
      action: "refund an overdue Dice Club bet",
      nonce: nonce.toString(),
      refund: `${cook(bet.amount)} COOK (+ the bet account's rent)`,
    },
  });
  return {
    status: "refunded",
    nonce: nonce.toString(),
    refunded: cook(bet.amount),
    signature,
    explorer: explorerTxUrl(signature),
  };
}
