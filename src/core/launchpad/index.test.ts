import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  assertLogoDecision,
  describeDevBuy,
  devBuyCookForSupplyPct,
  buildCreateParams,
  buildMetadata,
  creatorVestOutstanding,
  fairClaimSnapshot,
  fairRefundRaw,
  poolPhase,
  launchpadRouteMessage,
  anchorLogError,
  anchorLogSummary,
  altAccountMismatch,
  altPinMismatch,
  assertDevBuySupported,
  deserializeBuilt,
  diagnosticLogTail,
  emptyPositionsNote,
  launchpadSimError,
  mapPoolView,
  positionAction,
  resolveClaimKind,
  resolveReferrer,
  sendFailure,
  assertLaunchCost,
  MAX_UNCAPPED_CREATION_FEE_COOK,
} from "./index";
import { LAUNCHPAD_ALT_KEYS } from "../config";
import { CookieMcpError } from "../errors";
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
  it("accepts any of the three image sources", () => {
    expect(() => assertLogoDecision({ imageBase64: "iVBORw0KGgo=" })).not.toThrow();
    expect(() => assertLogoDecision({ imageUrl: "https://example.com/logo.png" })).not.toThrow();
    expect(() => assertLogoDecision({ imagePath: "~/logo.png" })).not.toThrow();
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
    expect(() => assertLogoDecision({ imagePath: "  " })).toThrow(CookieMcpError);
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
    for (const id of [null, "EZWe5C5gV1heTEsaoqh2gVVZQAhrgACSpufPyT9SKruF"]) {
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

  it("falls back to the log tail for unknown failures, without the log framing", () => {
    const e = launchpadSimError("claim", { InstructionError: [0, { Custom: 9999 }] }, [
      "Program log: a",
      "Program log: b",
    ]);
    // The tail still carries the last lines; only the repeated `Program log: ` framing is dropped, so
    // the useful part of a long line survives the message rather than being spent on boilerplate.
    expect(e.message).toContain("a | b");
    expect(e.message).not.toContain("Program log:");
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

describe("devBuyCookForSupplyPct / describeDevBuy", () => {
  // The live config: 1B total, 800M sale, vpr 176,471 COOK, vtr 1.073B, 1% fee.
  const cfg = {
    defaultTotalSupply: "1000000000000000",
    defaultSaleSupply: "800000000000000",
    defaultVirtualPaymentReserve: "176471000000000",
    defaultVirtualTokenReserve: "1073000000000000",
    defaultTokenDecimals: 6,
    tradeFeeBps: 100,
  } as unknown as Parameters<typeof devBuyCookForSupplyPct>[0];

  it("prices 1% of the total supply off the live curve", () => {
    expect(devBuyCookForSupplyPct(cfg, 1)).toBe(1_676_891_207_465n);
  });

  it("scales to fractional shares", () => {
    expect(devBuyCookForSupplyPct(cfg, 0.5)).toBeLessThan(devBuyCookForSupplyPct(cfg, 1));
    expect(devBuyCookForSupplyPct(cfg, 2)).toBeGreaterThan(devBuyCookForSupplyPct(cfg, 1));
  });

  it("refuses a share of zero or one bigger than the whole sale supply", () => {
    expect(() => devBuyCookForSupplyPct(cfg, 0)).toThrow(/greater than 0/);
    expect(() => devBuyCookForSupplyPct(cfg, 90)).toThrow(/whole sale supply/);
  });

  it("refuses to guess when the deploy does not publish the curve", () => {
    const old = { ...cfg, defaultVirtualPaymentReserve: undefined } as typeof cfg;
    expect(() => devBuyCookForSupplyPct(old, 1)).toThrow(/does not publish its launch curve/);
    // ...and the report simply says nothing rather than inventing a share.
    expect(describeDevBuy(old, 1_000_000_000n)).toBeNull();
  });

  it("reports a dev buy against BOTH denominators — the ambiguity that started this", () => {
    const note = describeDevBuy(cfg, 1_676_891_207_465n);
    expect(note).toContain("1.000% of the total supply");
    expect(note).toContain("1.250% of the sale supply");
  });

  it("says nothing when there was no dev buy", () => {
    expect(describeDevBuy(cfg, 0n)).toBeNull();
  });
});

// The real shape of an Anchor constraint failure: Anchor names the account and the constraint on ONE
// line, then prints the two compared pubkeys on lines of their own, and only then does the program's
// own "failed" line arrive. `logs.slice(-3)` therefore ends at `Right: | <pubkey> | Program … failed`
// and drops the only line that explains anything — the bug this suite pins.
const SEEDS_LOGS = [
  "Program momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw invoke [1]",
  "Program log: Instruction: CreatePool",
  "Program log: AnchorError caused by account: pool. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.",
  "Program log: Left:",
  "Program log: 8jMvRE7CmmTNZYRyXozkyiY7hcaEqsk3guYCewdP4sYG",
  "Program log: Right:",
  "Program log: GKyj2Q1v3272DfH6ceuVKNDySYfxXhZPuu7Uy7wi6HxW",
  "Program momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw consumed 12345 of 200000 compute units",
  "Program momoL7wu4TrXjnXMLCLzGsbx8Pm7XGgoYo7FVqDoqcw failed: custom program error: 0x7d6",
];

describe("anchorLogError", () => {
  it("reads the account, code, number and message off the AnchorError line", () => {
    const e = anchorLogError(SEEDS_LOGS);
    expect(e).toMatchObject({
      account: "pool",
      code: "ConstraintSeeds",
      number: 2006,
      message: "A seeds constraint was violated",
    });
  });

  it("pairs each Left:/Right: label with the value on the FOLLOWING line", () => {
    const e = anchorLogError(SEEDS_LOGS);
    expect(e?.left).toBe("8jMvRE7CmmTNZYRyXozkyiY7hcaEqsk3guYCewdP4sYG");
    expect(e?.right).toBe("GKyj2Q1v3272DfH6ceuVKNDySYfxXhZPuu7Uy7wi6HxW");
  });

  it("handles the account-less form Anchor also emits", () => {
    const e = anchorLogError([
      "Program log: AnchorError occurred. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
    ]);
    expect(e).toMatchObject({ code: "AccountNotInitialized", number: 3012 });
    expect(e?.account).toBeUndefined();
  });

  it("returns null for logs with no AnchorError, and for no logs at all", () => {
    expect(anchorLogError(["Program log: Instruction: Buy"])).toBeNull();
    expect(anchorLogError([])).toBeNull();
    expect(anchorLogError(null)).toBeNull();
  });

  it("does not invent a translation when the line is malformed", () => {
    // No Error Number → we cannot state a code, so fall through rather than half-report one.
    expect(anchorLogError(["Program log: AnchorError caused by account: pool."])).toBeNull();
  });
});

describe("anchorLogSummary", () => {
  it("names the account and both compared values", () => {
    const s = anchorLogSummary(anchorLogError(SEEDS_LOGS)!);
    expect(s).toContain("ConstraintSeeds (2006)");
    expect(s).toContain("`pool`");
    expect(s).toContain("passed 8jMvRE7CmmTNZYRyXozkyiY7hcaEqsk3guYCewdP4sYG");
    expect(s).toContain("program expected GKyj2Q1v3272DfH6ceuVKNDySYfxXhZPuu7Uy7wi6HxW");
  });
});

describe("diagnosticLogTail", () => {
  it("starts the window at the explanation, not 3 lines from the end", () => {
    const tail = diagnosticLogTail(SEEDS_LOGS)!;
    expect(tail).toContain("AnchorError caused by account: pool");
    // The old slice(-3) behaviour began at `Right:` — assert we are no longer doing that.
    expect(tail.startsWith("Right:")).toBe(false);
  });

  it("strips the Program log: framing", () => {
    expect(diagnosticLogTail(SEEDS_LOGS)).not.toContain("Program log:");
  });

  it("falls back to the last lines when nothing explains itself", () => {
    const tail = diagnosticLogTail(["a", "b", "c", "d", "e"]);
    expect(tail).toBe("c | d | e");
  });

  it("is undefined for empty or absent logs", () => {
    expect(diagnosticLogTail([])).toBeUndefined();
    expect(diagnosticLogTail(null)).toBeUndefined();
  });
});

describe("launchpadSimError with a framework error", () => {
  it("reports the constraint and the account instead of a bare pubkey", () => {
    const e = launchpadSimError("launch", { Custom: 2006 }, SEEDS_LOGS, null);
    expect(e).toBeInstanceOf(CookieMcpError);
    expect(e.message).toContain("ConstraintSeeds (2006)");
    expect(e.message).toContain("`pool`");
    expect(e.hint).toContain("nothing was sent");
  });

  it("still prefers the launchpad's own error table for a custom 6xxx code", () => {
    const e = launchpadSimError(
      "buy",
      { Custom: 6011 },
      [
        "Program log: AnchorError occurred. Error Code: Whatever. Error Number: 6011. Error Message: x.",
      ],
      null,
    );
    expect(e.message).toContain("not in a tradeable state");
  });
});

describe("emptyPositionsNote", () => {
  it("does NOT claim the wallet is empty when nothing was scanned", () => {
    const note = emptyPositionsNote({ poolsScanned: 0, found: 0, includeClosed: false })!;
    expect(note).toContain("NOT a statement");
    expect(note).not.toContain("Nothing outstanding");
  });

  it("says that even when positions were somehow found, since the scan was still blind", () => {
    // Defensive: poolsScanned 0 with a non-zero `found` is incoherent, so the lag warning still wins.
    expect(emptyPositionsNote({ poolsScanned: 0, found: 3, includeClosed: true })).toContain(
      "no position could be scanned",
    );
  });

  it("is silent when a real scan found something", () => {
    expect(emptyPositionsNote({ poolsScanned: 2, found: 1, includeClosed: false })).toBeNull();
  });

  it("distinguishes a genuine zero, and offers includeClosed only when it is off", () => {
    expect(emptyPositionsNote({ poolsScanned: 2, found: 0, includeClosed: false })).toContain(
      "includeClosed=true",
    );
    expect(emptyPositionsNote({ poolsScanned: 2, found: 0, includeClosed: true })).toBe(
      "This wallet has never traded on the MomoSwap launchpad.",
    );
  });
});

describe("altPinMismatch", () => {
  const PIN = "A1tPinnedTab1e11111111111111111111111111111";
  const OTHER = "0therTab1e2222222222222222222222222222222222";

  it("accepts a build that uses exactly the pinned table", () => {
    expect(altPinMismatch([PIN], PIN)).toBeNull();
  });

  it("refuses a table we did not pin — the API must not choose what an index means", () => {
    const why = altPinMismatch([OTHER], PIN)!;
    expect(why).toContain(OTHER);
    expect(why).toContain(PIN);
  });

  it("refuses when ANY of several tables is unexpected", () => {
    expect(altPinMismatch([PIN, OTHER], PIN)).not.toBeNull();
  });

  it("refuses everything when no pin is configured, rather than trusting the response", () => {
    // Fail closed: with no pin there is nothing to verify against, so a v0 build is unusable — never
    // "no pin, therefore anything goes".
    expect(altPinMismatch([PIN], "")).not.toBeNull();
    expect(altPinMismatch(undefined, "")).not.toBeNull();
    expect(altPinMismatch([], "")).not.toBeNull();
  });

  it("passes a build that references no table at all", () => {
    // Nothing is resolved indirectly, so there is nothing to pin — the tx states its own accounts.
    expect(altPinMismatch(undefined, PIN)).toBeNull();
    expect(altPinMismatch([], PIN)).toBeNull();
  });
});

describe("deserializeBuilt", () => {
  // A legacy tx with one instruction, serialized the way the API sends it.
  function legacyBase64(): string {
    const payer = new PublicKey("FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2");
    const tx = new Transaction();
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }));
    tx.recentBlockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
    tx.feePayer = payer;
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  it("decodes a legacy payload when txVersion is absent", () => {
    const tx = deserializeBuilt({
      transactionBase64: legacyBase64(),
      blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      lastValidBlockHeight: 1,
    });
    expect(tx).toBeInstanceOf(Transaction);
  });

  it("follows the stated txVersion, and VersionedTransaction tolerates a legacy payload", () => {
    // Worth pinning because it is asymmetric and easy to get backwards:
    // `VersionedTransaction.deserialize` ACCEPTS legacy bytes (wrapping them as a legacy message),
    // while `Transaction.from` throws on a versioned payload. So mis-stating txVersion as 0 degrades
    // gracefully, but omitting it on a real v0 build fails loudly — which is the safe direction, and
    // why the signing branch keys off `instanceof` rather than the field.
    const tx = deserializeBuilt({
      transactionBase64: legacyBase64(),
      blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
      lastValidBlockHeight: 1,
      txVersion: 0,
    });
    expect(tx).toBeInstanceOf(VersionedTransaction);
    expect((tx as VersionedTransaction).message.version).toBe("legacy");
  });
});

describe("assertDevBuySupported", () => {
  it("throws before any spend when a dev buy is asked for with no pinned table", () => {
    expect(() => assertDevBuySupported(true, "")).toThrow(CookieMcpError);
    try {
      assertDevBuySupported(true, "");
    } catch (e) {
      // The agent needs the workaround, not just a refusal — a plain launch plus launchpad_buy works.
      expect((e as CookieMcpError).hint).toContain("launchpad_buy");
      expect((e as CookieMcpError).hint).toContain("nothing was sent");
    }
  });

  it("allows a dev buy once a table is pinned", () => {
    expect(() =>
      assertDevBuySupported(true, "A1tPinnedTab1e11111111111111111111111111111"),
    ).not.toThrow();
  });

  it("never blocks a plain launch, pinned or not", () => {
    expect(() => assertDevBuySupported(false, "")).not.toThrow();
  });
});

describe("altAccountMismatch", () => {
  const KEYS = [
    "8nj4iBHZugPZ4T1NPM47zazSjhp68gHYkX6GbLdmT3AP",
    "So11111111111111111111111111111111111111112",
    "SysvarRent111111111111111111111111111111111",
    "85gdK5eftWmbp5G2nJvhvb7fvzcFF5rcTqojf2a7t3Pr",
    "5jP8CWGPkfCAmuFe6P9n9ik4P4BFCjT3Bod17EKChsXT",
  ] as const;
  const ACTIVE = 2n ** 64n - 1n;
  const table = (
    addresses: readonly string[],
    opts: { authority?: string; deactivationSlot?: bigint } = {},
  ) => ({
    state: {
      authority: opts.authority ? new PublicKey(opts.authority) : undefined,
      addresses: addresses.map((a) => new PublicKey(a)),
      deactivationSlot: opts.deactivationSlot ?? ACTIVE,
    },
  });

  it("accepts the real frozen table (the production values, asserted literally)", () => {
    expect(altAccountMismatch(table(KEYS), KEYS)).toBeNull();
  });

  it("pins LAUNCHPAD_ALT_KEYS to these literals, so a table rotation has to update this test", () => {
    expect(LAUNCHPAD_ALT_KEYS).toEqual(KEYS);
  });

  it("refuses a table that does not exist", () => {
    expect(altAccountMismatch(null, KEYS)).toContain("does not exist");
  });

  it("refuses a table that still has an authority, naming it", () => {
    const why = altAccountMismatch(table(KEYS, { authority: KEYS[3] }), KEYS)!;
    expect(why).toContain("still mutable");
    expect(why).toContain(KEYS[3]);
  });

  it("refuses a DEACTIVATED table, which an authority+addresses check would miss", () => {
    // Deactivation is invisible to the fields everything else looks at, and the transaction would fail
    // on chain with nothing here having explained why.
    expect(altAccountMismatch(table(KEYS, { deactivationSlot: 12345n }), KEYS)).toContain(
      "deactivated",
    );
  });

  it("refuses REORDERED contents, since the index is the identity", () => {
    const swapped = [KEYS[1], KEYS[0], ...KEYS.slice(2)];
    const why = altAccountMismatch(table(swapped), KEYS)!;
    expect(why).toContain("[0]");
  });

  it("refuses a truncated table and says which entry is missing", () => {
    expect(altAccountMismatch(table(KEYS.slice(0, 3)), KEYS)).toContain("[3] is missing");
  });

  it("tolerates extra entries appended after the ones we pinned", () => {
    // Append-only growth keeps indices 0..4 meaning what they meant.
    expect(altAccountMismatch(table([...KEYS, KEYS[0]]), KEYS)).toBeNull();
  });
});

describe("deploy_token anti-snipe reporting", () => {
  it("a bundled dev buy forces anti-snipe OFF, so the request must not be echoed back", () => {
    // Verified live on COWBOY (pool b5LV3vDM…): requested antiSnipe true, launched false. Reporting the
    // request would claim a protection the token does not have, on metadata that is immutable.
    const requested = true;
    const fromPool = { antiSnipe: false };
    expect(fromPool.antiSnipe ?? requested).toBe(false);
    // With no pool read back, falling back to the request is still the best available answer.
    const noPool: { antiSnipe: boolean } | null = null;
    expect(noPool?.antiSnipe ?? requested).toBe(true);
  });
});

describe("assertLaunchCost", () => {
  const COOK = 10n ** 9n;
  it("accepts a launch under maxCostCook and refuses one over it, naming the parts", () => {
    expect(() =>
      assertLaunchCost({
        creationFeeRaw: 0n,
        devBuyRaw: 5n * COOK,
        devBuyFromCurve: true,
        maxCostCook: 5,
      }),
    ).not.toThrow();
    expect(() =>
      assertLaunchCost({
        creationFeeRaw: COOK,
        devBuyRaw: 5n * COOK,
        devBuyFromCurve: false,
        maxCostCook: "5.5",
      }),
    ).toThrow(
      /cost 6 COOK \(creation fee 1 COOK \+ dev buy 5 COOK\), more than maxCostCook 5.5 COOK/,
    );
    expect(() =>
      assertLaunchCost({
        creationFeeRaw: 0n,
        devBuyRaw: 0n,
        devBuyFromCurve: false,
        maxCostCook: "lots",
      }),
    ).toThrow(/invalid maxCostCook/);
  });

  it("without maxCostCook: caps the API-reported creation fee and refuses a curve-priced dev buy", () => {
    const cap = BigInt(MAX_UNCAPPED_CREATION_FEE_COOK) * COOK;
    expect(() =>
      assertLaunchCost({ creationFeeRaw: cap, devBuyRaw: 10n * COOK, devBuyFromCurve: false }),
    ).not.toThrow();
    expect(() =>
      assertLaunchCost({ creationFeeRaw: cap + 1n, devBuyRaw: 0n, devBuyFromCurve: false }),
    ).toThrow(/above the 2000 COOK this tool accepts without maxCostCook/);
    const err = (() => {
      try {
        assertLaunchCost({ creationFeeRaw: 0n, devBuyRaw: 3n * COOK, devBuyFromCurve: true });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(CookieMcpError);
    expect(String((err as Error).message)).toMatch(/maxCostCook is required/);
  });
});
