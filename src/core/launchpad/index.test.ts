import { describe, it, expect } from "vitest";

import {
  assertLogoDecision,
  buildCreateParams,
  buildMetadata,
  creatorVestOutstanding,
  fairClaimSnapshot,
  fairRefundRaw,
  poolPhase,
  launchpadRouteMessage,
  launchpadSimError,
  mapPoolView,
  positionAction,
  resolveClaimKind,
  resolveReferrer,
  sendFailure,
} from "./index";
import { CookieMcpError } from "../errors";
import { LAUNCHPAD_PROGRAM_PRE_SLIPPAGE } from "./program";
import type { LaunchpadPool } from "./api";

// Shape mirrors GET /v1/launchpad/pools for the live pool 3YyYM3J8… (SAKURA, expired/fair).
const POOL: LaunchpadPool = {
  pubkey: "3YyYM3J8wa3dda6FBQKP3f1QvDZ7buc12WyvSM4BuUYP",
  creator: "J1mjnWwuM1XbPNsz49jRy8oYEXXvoD7vuToXXq53S5Lp",
  poolId: "8858466041478465063",
  name: "SAKURA",
  symbol: "SAKURA",
  uri: "ipfs://QmZZyCMT3bpH9yfmozHxherrnUW6aMWTm7LnnCTYyoUqYJ",
  tokenMint: "GZz64mDYunaZeVxAbirMMUekGpQjf2Y7kG8oR7cSmomo",
  paymentMint: "So11111111111111111111111111111111111111112",
  tokenVault: "7qiasnu1qDbGLT5TTfRxUyWPAy3NzTpf6yKvKkkyVtQa",
  paymentVault: "A4PifVNkZiC42TLYftHBTvSMq6cGcTR2PPqUCrsmrrB7",
  launchTs: 1781366580,
  endTs: 1781370180,
  durationSecs: 3600,
  expiryMode: "fair",
  migratable: true,
  antiSnipe: false,
  state: "expired",
  status: "expired",
  minBuy: "0",
  maxBuyPerWallet: "0",
  maxPaymentRaise: "0",
  totalTokenSupply: "1000000000000000",
  saleTokenSupply: "800000000000000",
  virtualPaymentReserve: "176471000000000",
  virtualTokenReserve: "1073000000000000",
  tokensSold: "6108368870161",
  totalActiveShares: "6108368870161",
  paymentRaisedGross: "1018000000000",
  paymentRaisedNet: "1010365000000",
  participantCount: "2",
  expiryLiquidity: "1010365000000",
  totalExpiryShares: "6108368870161",
  settlementRootSet: false,
  graduatedAt: 0,
  creatorVestAmount: "0",
  creatorVestClaimed: "0",
  creatorVestStart: 0,
  creatorVestEnd: 0,
  graduationTarget: "500000000000000",
};

describe("poolPhase", () => {
  // The API reports a past-end_ts pool as `live` while its on-chain state is still `Open` (nothing
  // calls the permissionless expire_pool). Trading reverts and claims revert in that window, so it
  // must not be presented as live.
  const LIVE = { ...POOL, status: "live" as const, endTs: 2_000_000_000 };

  it("passes through a genuinely live pool", () => {
    expect(poolPhase(LIVE, 1_999_999_999)).toBe("live");
  });

  it("reports `ended` once the launch window has closed but the pool is still on-chain Open", () => {
    expect(poolPhase(LIVE, 2_000_000_001)).toBe("ended");
  });

  it("treats the boundary second as still live (the program allows now <= end_ts)", () => {
    expect(poolPhase(LIVE, 2_000_000_000)).toBe("live");
  });

  it("never overrides a settled status", () => {
    expect(poolPhase({ ...POOL, status: "expired" }, 2_000_000_001)).toBe("expired");
    expect(poolPhase({ ...POOL, status: "graduated" }, 2_000_000_001)).toBe("graduated");
    expect(poolPhase({ ...POOL, status: "upcoming", endTs: 3_000_000_000 }, 1_000)).toBe(
      "upcoming",
    );
  });
});

describe("mapPoolView", () => {
  it("converts raw u64 strings to UI amounts and derives progress + links", () => {
    const v = mapPoolView(POOL, 6, 9, POOL.endTs + 1);
    expect(v.pool).toBe(POOL.pubkey);
    expect(v.mint).toBe(POOL.tokenMint);
    expect(v.raisedCook).toBe("1010.365");
    expect(v.graduationTargetCook).toBe("500000");
    expect(v.graduationProgressPct).toBeCloseTo(0.2021, 4);
    expect(v.tokensSold).toBe("6108368.870161");
    expect(v.saleSupply).toBe("800000000");
    expect(v.participants).toBe(2);
    expect(v.links.token).toBe(`https://momoswap.fun/token/${POOL.tokenMint}`);
    expect(v.links.launchpad).toBe(`https://momoswap.fun/pool/${POOL.pubkey}`);
  });

  it("reports an unset per-wallet cap as null, not 0", () => {
    expect(mapPoolView(POOL, 6).maxBuyPerWalletCook).toBeNull();
    expect(mapPoolView({ ...POOL, maxBuyPerWallet: "5000000000" }, 6).maxBuyPerWalletCook).toBe(
      "5",
    );
  });

  it("surfaces `ended` in the view so a filtered `live` list cannot mislead", () => {
    const stillOpen = { ...POOL, status: "live" as const, endTs: 1_000 };
    expect(mapPoolView(stillOpen, 6, 9, 999).status).toBe("live");
    expect(mapPoolView(stillOpen, 6, 9, 1_001).status).toBe("ended");
  });
});

describe("assertLogoDecision", () => {
  // Why this is a hard pre-flight and not a warning: the old design only reported "launched without a
  // logo" on the RESULT, i.e. after mint + freeze authority were renounced and the metadata was frozen.
  // Both live validation launches on 2026-07-29 shipped logo-less despite an "ALWAYS give the token a
  // logo" line in the tool description, which is what proved prose insufficient.
  it("accepts either image source", () => {
    expect(() => assertLogoDecision({ imageBase64: "iVBORw0KGgo=" })).not.toThrow();
    expect(() => assertLogoDecision({ imageUrl: "https://example.com/logo.png" })).not.toThrow();
  });

  it("refuses a logo-less launch and names the escape hatch", () => {
    try {
      assertLogoDecision({});
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(CookieMcpError);
      expect((e as CookieMcpError).message).toContain("no logo");
      expect((e as CookieMcpError).hint).toContain("noLogo: true");
      expect((e as CookieMcpError).hint).toContain("immutable");
    }
  });

  it("treats blank/whitespace image fields as absent, not as a logo", () => {
    expect(() => assertLogoDecision({ imageUrl: "   " })).toThrow(CookieMcpError);
    expect(() => assertLogoDecision({ imageBase64: "" })).toThrow(CookieMcpError);
  });

  it("lets an explicit opt-out through", () => {
    expect(() => assertLogoDecision({ noLogo: true })).not.toThrow();
    // ...but a falsy flag is not an opt-out.
    expect(() => assertLogoDecision({ noLogo: false })).toThrow(CookieMcpError);
  });
});

describe("fairRefundRaw", () => {
  // Golden, from the 2026-07-29 live validation: pool EKkxjFhW… paid this wallet exactly 14898142 raw
  // COOK for 90585448 shares. Verified against the pool's payment-vault delta on the claim tx
  // (4Tf7Rwp4…), so this pins MCP's arithmetic to a real on-chain payout.
  const SNAPSHOT = { expiryLiquidity: "14898142", totalExpiryShares: "90585448" };

  it("reproduces a real on-chain fair refund", () => {
    expect(fairRefundRaw(SNAPSHOT, 90_585_448n)).toBe(14_898_142n);
  });

  it("is proportional for a partial holder and floors like the program's mul_div", () => {
    // The live case was the only holder (shares == totalExpiryShares), which does not exercise the
    // ratio — so cover it here. A third of the shares earns a third of the pot, rounded DOWN.
    expect(fairRefundRaw({ expiryLiquidity: "1000", totalExpiryShares: "3000" }, 1_000n)).toBe(
      333n,
    );
    expect(fairRefundRaw({ expiryLiquidity: "100", totalExpiryShares: "1000" }, 500n)).toBe(50n);
  });

  it("returns null rather than a bogus 0 when there is nothing to compute from", () => {
    // An unexpired pool has a zeroed snapshot; the program rejects a zero claim as NothingToClaim.
    expect(fairRefundRaw({ expiryLiquidity: "0", totalExpiryShares: "0" }, 100n)).toBeNull();
    expect(fairRefundRaw(SNAPSHOT, 0n)).toBeNull();
    // A dust holder whose proportional share floors to zero gets null, not "0.000000000".
    expect(fairRefundRaw({ expiryLiquidity: "10", totalExpiryShares: "1000" }, 1n)).toBeNull();
  });

  it("refuses a share count larger than the whole snapshot instead of over-reporting", () => {
    expect(fairRefundRaw(SNAPSHOT, 90_585_449n)).toBeNull();
  });

  it("survives malformed numbers from the API", () => {
    expect(fairRefundRaw({ expiryLiquidity: "", totalExpiryShares: "1" }, 1n)).toBeNull();
    expect(fairRefundRaw({ expiryLiquidity: "abc", totalExpiryShares: "1" }, 1n)).toBeNull();
  });
});

describe("resolveClaimKind", () => {
  it("claims the SPL token after graduation", () => {
    expect(resolveClaimKind({ status: "graduated", expiryMode: "dead" })).toBe("graduated_tokens");
  });

  it("claims a refund for a Fair expiry and a Merkle payout for Jackpot/Survivor", () => {
    expect(resolveClaimKind({ status: "expired", expiryMode: "fair" })).toBe("fair");
    expect(resolveClaimKind({ status: "expired", expiryMode: "jackpot" })).toBe("winner");
    expect(resolveClaimKind({ status: "expired", expiryMode: "survivor" })).toBe("winner");
  });

  it("has nothing to claim for a Dead expiry or a still-running pool", () => {
    expect(resolveClaimKind({ status: "expired", expiryMode: "dead" })).toBeNull();
    expect(resolveClaimKind({ status: "live", expiryMode: "fair" })).toBeNull();
    expect(resolveClaimKind({ status: "upcoming", expiryMode: "fair" })).toBeNull();
  });

  // In the `ended` window the pool is past end_ts but still `Open` on-chain. `claim_fair` expires it
  // itself (audit #2 lazy_expire, merged as 62525aa), so a Fair refund IS reachable there — and only
  // Fair: `set_settlement_root` requires an already-`Expired` pool, so no Merkle root can exist for a
  // jackpot/survivor pool in this window, and Dead has no holder payout at any point.
  it("claims a Fair refund in the ended window, which settles the pool", () => {
    expect(resolveClaimKind({ status: "ended", expiryMode: "fair" })).toBe("fair");
  });

  it("has nothing to claim in the ended window for any other mode", () => {
    for (const mode of ["dead", "jackpot", "survivor"] as const) {
      expect(resolveClaimKind({ status: "ended", expiryMode: mode })).toBeNull();
    }
  });
});

describe("buildMetadata", () => {
  it("uppercases the symbol, trims, and normalizes social handles to URLs", () => {
    const md = buildMetadata(
      {
        name: "  Momo Coin ",
        symbol: " momo ",
        description: " a test ",
        twitter: "@momoswap",
        telegram: "momoswap",
        website: "https://momoswap.fun",
      },
      "https://gateway.pinata.cloud/ipfs/CID",
    );
    expect(md).toEqual({
      name: "Momo Coin",
      symbol: "MOMO",
      description: "a test",
      image: "https://gateway.pinata.cloud/ipfs/CID",
      extensions: {
        website: "https://momoswap.fun",
        twitter: "https://x.com/momoswap",
        telegram: "https://t.me/momoswap",
      },
    });
  });

  it("keeps full URLs as given and omits empty fields", () => {
    const md = buildMetadata({
      name: "Bare",
      symbol: "BARE",
      twitter: "https://x.com/someone",
    });
    expect(md).toEqual({
      name: "Bare",
      symbol: "BARE",
      extensions: { twitter: "https://x.com/someone" },
    });
    expect(md.image).toBeUndefined();
  });
});

describe("buildCreateParams", () => {
  it("defaults to a 1-day fair launch with anti-snipe on and no raise cap", () => {
    const p = buildCreateParams({ name: "Momo", symbol: "momo" });
    expect(p).toEqual({
      name: "Momo",
      symbol: "MOMO",
      launch_ts: 0,
      duration_secs: 86_400,
      expiry_mode: "fair",
      migratable: true,
      anti_snipe: true,
      min_buy: "0",
      max_buy_per_wallet: "0",
      max_payment_raise: "0",
    });
  });

  it("converts COOK limits to base units", () => {
    const p = buildCreateParams({
      name: "Momo",
      symbol: "MOMO",
      minBuyCook: 0.5,
      maxBuyPerWalletCook: "250",
      durationSecs: 3600,
      expiryMode: "jackpot",
      antiSnipe: false,
    });
    expect(p.min_buy).toBe("500000000");
    expect(p.max_buy_per_wallet).toBe("250000000000");
    expect(p.duration_secs).toBe(3600);
    expect(p.expiry_mode).toBe("jackpot");
    expect(p.anti_snipe).toBe(false);
  });

  it("rejects names/symbols over the on-chain limits", () => {
    expect(() => buildCreateParams({ name: "", symbol: "MOMO" })).toThrow(CookieMcpError);
    expect(() => buildCreateParams({ name: "x".repeat(33), symbol: "MOMO" })).toThrow(
      CookieMcpError,
    );
    expect(() => buildCreateParams({ name: "Momo", symbol: "TOOLONGSYMBOL" })).toThrow(
      CookieMcpError,
    );
  });

  it("rejects durations outside the on-chain 60s–7d window", () => {
    expect(() => buildCreateParams({ name: "Momo", symbol: "MOMO", durationSecs: 59 })).toThrow(
      CookieMcpError,
    );
    expect(() =>
      buildCreateParams({ name: "Momo", symbol: "MOMO", durationSecs: 604_801 }),
    ).toThrow(CookieMcpError);
  });
});

describe("positionAction", () => {
  const held = {
    shares: "3017341406",
    claimed: false,
    winnerClaimed: false,
    graduatedTokensClaimed: false,
  };
  const empty = { ...held, shares: "0" };

  it("flags unclaimed SPL tokens on a graduated pool", () => {
    const a = positionAction({ status: "graduated", expiryMode: "dead" }, held);
    expect(a).toMatchObject({ tool: "claim_launchpad", kind: "graduated_tokens" });
  });

  it("says nothing once graduated tokens are claimed, or when there were no shares", () => {
    expect(
      positionAction(
        { status: "graduated", expiryMode: "dead" },
        { ...held, graduatedTokensClaimed: true },
      ),
    ).toBeNull();
    expect(positionAction({ status: "graduated", expiryMode: "dead" }, empty)).toBeNull();
  });

  it("offers a sell while the curve is live", () => {
    expect(positionAction({ status: "live", expiryMode: "fair" }, held)).toMatchObject({
      tool: "launchpad_sell",
      kind: "sell",
    });
    expect(positionAction({ status: "live", expiryMode: "fair" }, empty)).toBeNull();
  });

  it("routes an expired launch by settlement mode, and stays quiet once claimed", () => {
    expect(positionAction({ status: "expired", expiryMode: "fair" }, held)).toMatchObject({
      kind: "fair",
    });
    expect(
      positionAction({ status: "expired", expiryMode: "fair" }, { ...held, claimed: true }),
    ).toBeNull();
    expect(positionAction({ status: "expired", expiryMode: "survivor" }, held)).toMatchObject({
      kind: "winner",
    });
    expect(
      positionAction(
        { status: "expired", expiryMode: "jackpot" },
        { ...held, winnerClaimed: true },
      ),
    ).toBeNull();
    // Dead mode sweeps unraised funds to the treasury — there is nothing for a holder to collect.
    expect(positionAction({ status: "expired", expiryMode: "dead" }, held)).toBeNull();
  });

  it("has nothing to say about a launch that has not opened", () => {
    expect(positionAction({ status: "upcoming", expiryMode: "fair" }, held)).toBeNull();
  });

  // Selling always reverts in the ended window (past end_ts), but a Fair claim settles the pool itself,
  // so it is the one actionable thing there.
  it("offers the Fair claim in the ended window, and nothing for the other modes", () => {
    expect(positionAction({ status: "ended", expiryMode: "fair" }, held)).toMatchObject({
      tool: "claim_launchpad",
      kind: "fair",
    });
    expect(
      positionAction({ status: "ended", expiryMode: "fair" }, { ...held, claimed: true }),
    ).toBeNull();
    expect(positionAction({ status: "ended", expiryMode: "fair" }, empty)).toBeNull();
    for (const mode of ["dead", "jackpot", "survivor"] as const) {
      expect(positionAction({ status: "ended", expiryMode: mode }, held)).toBeNull();
    }
  });
});

describe("fairClaimSnapshot", () => {
  const ENDED = {
    status: "ended" as const,
    expiryLiquidity: "0", // the program only writes these at the expiry transition
    totalExpiryShares: "0",
    totalActiveShares: "120390305",
  };

  // Without this, a Fair claim in the ended window reports `claimed: null` — the pool's own snapshot is
  // still zeroed at the moment the claim is built, because `claim_fair` is what fills it in.
  it("reconstructs the snapshot lazy_expire is about to write", () => {
    expect(fairClaimSnapshot(ENDED, 19_800_000n)).toEqual({
      expiryLiquidity: "19800000",
      totalExpiryShares: "120390305",
    });
  });

  it("uses the pool's own snapshot once it is settled on-chain", () => {
    const settled = {
      status: "expired" as const,
      expiryLiquidity: "19800000",
      totalExpiryShares: "120390305",
      totalActiveShares: "0", // zeroed after settlement — must NOT be used as the divisor
    };
    expect(fairClaimSnapshot(settled, null)).toMatchObject({
      expiryLiquidity: "19800000",
      totalExpiryShares: "120390305",
    });
  });

  it("gives up rather than guessing when the vault balance is unavailable", () => {
    expect(fairClaimSnapshot(ENDED, null)).toBeNull();
    expect(fairClaimSnapshot(ENDED, 0n)).toBeNull();
  });

  // End to end: the reconstructed snapshot feeds the same refund formula, and reproduces the real
  // 0.0198 COOK refund measured on pool 8tZWFQ5V… from its pre-expiry vault balance.
  it("feeds fairRefundRaw to the same answer the settled pool gives", () => {
    const snap = fairClaimSnapshot(ENDED, 19_800_000n)!;
    expect(fairRefundRaw(snap, 120_390_305n)).toBe(19_800_000n);
  });
});

describe("creatorVestOutstanding", () => {
  it("returns what is left of the vest", () => {
    expect(
      creatorVestOutstanding({ creatorVestAmount: "198000000", creatorVestClaimed: "0" }),
    ).toBe(198_000_000n);
    expect(
      creatorVestOutstanding({ creatorVestAmount: "198000000", creatorVestClaimed: "98000000" }),
    ).toBe(100_000_000n);
  });

  it("never goes negative and is 0 for a pool with no vest", () => {
    expect(creatorVestOutstanding({ creatorVestAmount: "0", creatorVestClaimed: "0" })).toBe(0n);
    expect(creatorVestOutstanding({ creatorVestAmount: "100", creatorVestClaimed: "150" })).toBe(
      0n,
    );
  });
});

describe("launchpadRouteMessage", () => {
  it("sends a live curve to launchpad_buy/sell and reports how far off graduation it is", () => {
    const m = launchpadRouteMessage({
      ...POOL,
      status: "live",
      paymentRaisedNet: "250000000000000",
    });
    expect(m?.error).toContain("bonding curve");
    expect(m?.hint).toContain("launchpad_buy");
    expect(m?.hint).toContain("50%");
    expect(m?.hint).toContain(POOL.pubkey);
  });

  it("explains an upcoming launch with its opening time", () => {
    const m = launchpadRouteMessage({ ...POOL, status: "upcoming" });
    expect(m?.error).toContain(new Date(POOL.launchTs * 1000).toISOString());
    expect(m?.hint).toContain("launchpad_buy");
  });

  it("routes an expired launch to the claim that matches its settlement mode", () => {
    expect(launchpadRouteMessage({ ...POOL, expiryMode: "fair" })?.hint).toContain("refund");
    expect(launchpadRouteMessage({ ...POOL, expiryMode: "dead" })?.hint).toContain(
      "no holder payout",
    );
    expect(launchpadRouteMessage({ ...POOL, expiryMode: "jackpot" })?.hint).toContain("Merkle");
  });

  it("stays silent for a graduated pool — it has a real market, so 'no route' means low liquidity", () => {
    expect(launchpadRouteMessage({ ...POOL, status: "graduated" })).toBeNull();
  });

  it("does not send an ended pool to launchpad_buy", () => {
    const m = launchpadRouteMessage({ ...POOL, status: "ended" });
    expect(m?.error).toContain("window has closed");
    expect(m?.hint).not.toContain("launchpad_buy");
  });
});

describe("sendFailure", () => {
  // Every one of these reached the agent as a raw web3 SendTransactionError before. The stale-blockhash
  // case is the one that actually happens: the launchpad API builds against its own RPC node, and on
  // 2026-07-29 that node was ~4,000 slots behind, so the blockhash was expired on arrival.
  it("translates an expired blockhash without implying funds moved", () => {
    for (const raw of [
      "Transaction simulation failed: Blockhash not found",
      "Node is behind by 3991 slots",
      "block height exceeded",
    ]) {
      const e = sendFailure("launch", new Error(raw));
      expect(e.message).toContain("expired before it could be sent");
      expect(e.hint).toContain("nothing was sent");
    }
  });

  it("translates insufficient funds and falls back to the raw message otherwise", () => {
    expect(
      sendFailure("buy", new Error("Transfer: insufficient lamports 10, need 20")).message,
    ).toContain("insufficient funds");
    const other = sendFailure("sell", new Error("socket hang up"));
    expect(other.message).toContain("socket hang up");
    expect(other.hint).toContain("nothing was sent");
  });
});

describe("launchpadSimError", () => {
  it("translates known launchpad program errors", () => {
    const e = launchpadSimError("buy", { InstructionError: [1, { Custom: 6012 }] }, null);
    expect(e.message).toContain("trading has not opened yet");
    // 6021 is InsufficientShares on EVERY build — the codes never renumbered (see program.test.ts).
    // An earlier version of this test asserted 6022 here, matching a phantom +1 shift MCP had taken
    // from the launchpad's (wrong) IDL; the program id must make no difference.
    for (const id of [null, LAUNCHPAD_PROGRAM_PRE_SLIPPAGE]) {
      expect(
        launchpadSimError("sell", { InstructionError: [1, { Custom: 6021 }] }, null, id).message,
      ).toContain("more shares than you hold");
    }
  });

  it("flags a stalled chain and insufficient funds distinctly", () => {
    expect(launchpadSimError("buy", "BlockhashNotFound", null).hint).toContain("chain_health");
    expect(
      launchpadSimError("buy", { InstructionError: [0, "Custom"] }, [
        "Transfer: insufficient lamports 1000, need 2000000000000",
      ]).message,
    ).toContain("insufficient funds");
  });

  it("falls back to the log tail for unknown failures", () => {
    const e = launchpadSimError("claim", { InstructionError: [0, { Custom: 9999 }] }, [
      "Program log: a",
      "Program log: b",
    ]);
    expect(e.message).toContain("Program log: b");
  });

  // A Fair claim on an `ended` pool needs the program to expire the pool as part of the claim. Where that
  // is absent the revert is 6011, whose generic reading — "it has graduated or expired" — is the exact
  // opposite of the truth, so the claim path overrides just that code.
  it("lets a caller override one code's reading without touching the others", () => {
    const hints = { 6011: { message: "not settled yet", hint: "retry shortly" } };
    const e = launchpadSimError(
      "claim",
      { InstructionError: [1, { Custom: 6011 }] },
      null,
      null,
      hints,
    );
    expect(e.message).toBe("not settled yet");
    expect(e.hint).toBe("retry shortly");
    // Without the override, the same code keeps the table's wording.
    expect(
      launchpadSimError("buy", { InstructionError: [1, { Custom: 6011 }] }, null).message,
    ).toContain("not in a tradeable state");
    // An unrelated code is unaffected by the presence of the override.
    expect(
      launchpadSimError("claim", { InstructionError: [1, { Custom: 6012 }] }, null, null, hints)
        .message,
    ).toContain("trading has not opened yet");
  });
});

describe("resolveReferrer", () => {
  const BUYER = "9rj5GEEyGGV9dTgAf9zJbFHqSjmMwYhtLdBQr6TWCmL8";
  const DEFAULT = "B8AB9R9J98yggrwdnZhoHuGJBc8RzTpHsqDnRkTnMuV";
  const OTHER = "J1mjnWwuM1XbPNsz49jRy8oYEXXvoD7vuToXXq53S5Lp";

  it("credits the configured default when the caller names nobody", () => {
    expect(resolveReferrer(undefined, BUYER, DEFAULT)).toBe(DEFAULT);
  });

  it("lets an explicit referrer win over the default", () => {
    expect(resolveReferrer(OTHER, BUYER, DEFAULT)).toBe(OTHER);
  });

  it("rejects an explicitly self-referring buy", () => {
    expect(() => resolveReferrer(BUYER, BUYER, DEFAULT)).toThrow(CookieMcpError);
  });

  // The wallet running the server may BE the configured referrer. The program rejects self-referral,
  // so the fallback has to drop out rather than turn every one of that wallet's buys into an error.
  it("drops the default when it is the buyer, instead of throwing", () => {
    expect(resolveReferrer(undefined, BUYER, BUYER)).toBeNull();
  });

  it("treats an empty COOKIE_REFERRER as opting out", () => {
    expect(resolveReferrer(undefined, BUYER, "")).toBeNull();
  });

  // Ambient config the trader may not have set must never break their buy: a malformed default is
  // worth losing the referral over, not the trade. (An explicit argument is the caller's own input,
  // so it is passed through and the API validates it.)
  it("ignores a malformed default rather than failing the buy", () => {
    expect(resolveReferrer(undefined, BUYER, "not-a-pubkey")).toBeNull();
  });
});
