import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { describePendingBet, describeResolution, minutesUntil, refusalError } from "./index";
import { checkBet, sha256, type HouseRules } from "./math";
import { betAddress, type Bet, type House, type ResolvedEvent } from "./program";

const COOK = 1_000_000_000n;
const PLAYER = new PublicKey("zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok");
const serverSeed = Buffer.alloc(32, 0x11);
const clientSeed = Buffer.alloc(32, 0x22);

// deriveRoll(0x11…, 0x22…, 0) = 3909 — a win at 50%.
const settled: ResolvedEvent = {
  player: PLAYER.toBase58(),
  nonce: 0n,
  amount: COOK,
  target: 5000,
  paid: 1_980_000_000n,
  clientSeed,
  commitment: sha256(serverSeed),
  placementCommitment: sha256(serverSeed),
  serverSeed,
  seedIndex: 0n,
  roll: 3909,
  won: true,
  expired: false,
};

describe("describeResolution", () => {
  it("reports a verified win", () => {
    const r = describeResolution(settled, "sig", {
      expectedClientSeed: clientSeed,
      winPayout: 1_980_000_000n,
    });
    expect(r).toMatchObject({
      status: "won",
      roll: "39.09",
      rollUnder: "50.00",
      paid: "1.98",
      net: "+0.98",
      proof: { verified: true, clientSeedIsOurs: true },
    });
    expect(r).not.toHaveProperty("warning");
    expect(r.bet).toBe(betAddress(PLAYER, 0n).toBase58());
    expect((r as { proof: { verifyUrl: string } }).proof.verifyUrl).toContain(
      "&nonce=0&target=5000",
    );
  });

  it("warns when the published roll is not what the seed derives", () => {
    const r = describeResolution({ ...settled, roll: 6000, won: false, paid: 0n }, "sig");
    expect(r).toMatchObject({ proof: { verified: false, rollRederived: false } });
    expect(r).toHaveProperty("warning");
  });

  it("flags a settle that used a client seed other than the one we sent", () => {
    const r = describeResolution(settled, "sig", { expectedClientSeed: Buffer.alloc(32, 1) });
    expect(r).toMatchObject({ proof: { verified: false, clientSeedIsOurs: false } });
  });

  it("reports an expiry as a refund with no roll", () => {
    const r = describeResolution(
      { ...settled, expired: true, won: false, paid: COOK, serverSeed: Buffer.alloc(32) },
      "sig",
    );
    expect(r).toMatchObject({ status: "refunded", paid: "1", net: "0" });
    expect(r).not.toHaveProperty("roll");
  });

  it("shows a loss as a negative net", () => {
    const r = describeResolution({ ...settled, target: 3000, won: false, paid: 0n }, "sig");
    expect(r).toMatchObject({ status: "lost", net: "-1", proof: { verified: true } });
  });
});

describe("describePendingBet", () => {
  const bet: Bet = {
    address: betAddress(PLAYER, 5n),
    player: PLAYER,
    nonce: 5n,
    amount: COOK,
    payout: 1_980_000_000n,
    target: 5000,
    clientSeed,
    placementCommitment: Buffer.alloc(32),
    deadlineSlot: 1_000n,
  };
  const house = (settledNonce: bigint) => ({ settledNonce }) as House;

  it("waiting for the keeper", () => {
    const d = describePendingBet(bet, house(5n), 900n);
    expect(d).toMatchObject({ betsAhead: 0, refundable: false });
    expect(d.note).toMatch(/refundable in ~1 min/);
  });

  it("refundable once past the deadline and first in line", () => {
    expect(describePendingBet(bet, house(5n), 1_000n)).toMatchObject({ refundable: true });
  });

  it("past the deadline but behind older bets", () => {
    expect(describePendingBet(bet, house(3n), 2_000n)).toMatchObject({
      refundable: false,
      betsAhead: 2,
    });
  });

  it("minutesUntil rounds up and floors at 0", () => {
    expect(minutesUntil(1_000n, 2_000n)).toBe(0);
    expect(minutesUntil(1_000n, 999n)).toBe(1);
  });
});

describe("refusalError", () => {
  const rules: HouseRules = { edgeBps: 100n, minBetLamports: COOK, maxPayoutBps: 100n };

  it("names the max stake when the bankroll caps the bet", () => {
    const check = checkBet(
      rules,
      { paused: false, pending: 0n, free: 1_000n * COOK },
      100n * COOK,
      5000,
    );
    const e = refusalError(check, rules, 5000);
    expect(e.message).toMatch(/more than the bankroll/);
    expect(e.hint).toMatch(/10\.204081632 COOK/);
  });

  it("names the minimum stake", () => {
    const check = checkBet(rules, { paused: false, pending: 0n, free: 1_000n * COOK }, 1n, 5000);
    expect(refusalError(check, rules, 5000).message).toMatch(/minimum of 1 COOK/);
  });
});
