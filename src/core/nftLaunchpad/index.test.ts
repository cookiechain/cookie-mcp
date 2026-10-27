import { describe, expect, it } from "vitest";

import type { NftCollection } from "./api";
import {
  NFT_ITEM_RENT_ALLOWANCE,
  NFT_REQUEST_DEPOSIT_ALLOWANCE,
  dropPhase,
  holderExit,
  mapDropSummary,
  nftSimError,
  planNftDrop,
  refundBudget,
  requestBudget,
  settleBudget,
  spendCap,
} from "./index";
import { NATIVE_FEE_ALLOWANCE } from "../spendGuard";

const NOW = 1_800_000_000;

/** A live sell-out drop, shaped like api.momoswap.fun's `/v1/nft/collection/:mint`. */
function drop(over: Partial<NftCollection> = {}): NftCollection {
  return {
    address: "Ez1qjJ32rdhUcXNAhuajPHKQswCcjJ93KhEaJRYEfPYw",
    collectionMint: "8TWT6i5Cpdp81LHmSvZGoAK2AxrVv6D5C5iG51dZ4LF5",
    creator: "4GGk4vTDd1FCA4NHd62xcwcab86KAm6dFtG7zrGKSGUx",
    paymentMint: "So11111111111111111111111111111111111111112",
    name: "Sweetardios",
    symbol: "SWEET",
    baseUri: "ipfs://bafy/",
    collectionUri: "ipfs://Qm",
    state: "active",
    totalSupply: "444",
    minted: "121",
    inventory: "0",
    burned: "0",
    circulating: "121",
    remaining: "323",
    available: "323",
    launchTs: NOW - 3_600,
    endTs: NOW + 3_600,
    maxPerWallet: "0",
    allowlistEndTs: 0,
    hasAllowlist: false,
    revealed: false,
    revealedOnChain: false,
    antiSnipe: true,
    floorLockBps: 2_500,
    floorReserve: "0",
    floorRedeemable: "0",
    floorPriceRaw: "0",
    sellerFeeBps: 650,
    royaltyPartner: "11111111111111111111111111111111",
    partnerShareBps: 0,
    windDown: { available: false, needsClose: false, priceRaw: "0" },
    graduation: {
      model: "sellout",
      targetRaw: "0",
      selloutRaiseRaw: "8692600000000000",
      targetBps: null,
      raisedRaw: "1371322816166949",
      progressBps: 2725,
      unitsToTarget: null,
      graduated: false,
      graduatedAt: null,
    },
    postGraduation: null,
    ...over,
  };
}

describe("dropPhase", () => {
  it("reads every phase from state, window and supply", () => {
    expect(dropPhase(drop(), NOW)).toBe("live");
    expect(dropPhase(drop({ launchTs: NOW + 60 }), NOW)).toBe("upcoming");
    expect(dropPhase(drop({ available: "0" }), NOW)).toBe("sold-out");
    // Past its window but not closed on chain yet: nothing can be minted or sold back.
    expect(dropPhase(drop({ endTs: NOW - 1 }), NOW)).toBe("ended");
    expect(dropPhase(drop({ state: "closed" }), NOW)).toBe("ended");
    expect(dropPhase(drop({ state: "graduated" }), NOW)).toBe("graduated");
    expect(dropPhase(drop({ state: "graduated", postGraduation: { open: true } }), NOW)).toBe(
      "minting",
    );
  });

  it("allows minting right up to end_ts, as the program does", () => {
    expect(dropPhase(drop({ endTs: NOW }), NOW)).toBe("live");
  });
});

describe("holderExit", () => {
  it("names the tool that applies in each phase", () => {
    expect(holderExit(drop(), "live")).toMatch(/nft_drop_sell/);
    expect(holderExit(drop(), "live")).not.toMatch(/nft_drop_graduate/);
    expect(holderExit(drop(), "sold-out")).toMatch(/nft_drop_sell.*nft_drop_graduate/);
    expect(holderExit(drop({ floorPriceRaw: "2500000000" }), "graduated")).toMatch(
      /2\.5 COOK floor with nft_drop_redeem/,
    );
    expect(holderExit(drop(), "graduated")).toMatch(/^list an item on Baked Bazaar/);
    expect(
      holderExit(
        drop({ windDown: { available: true, needsClose: true, priceRaw: "1000000000" } }),
        "ended",
      ),
    ).toMatch(/1 COOK wind-down refund/);
    expect(holderExit(drop(), "ended")).toMatch(/once the drop is closed/);
  });
});

describe("mapDropSummary", () => {
  it("states the raise against the sell-out for a sell-out drop", () => {
    expect(mapDropSummary(drop(), NOW)).toMatchObject({
      phase: "live",
      graduation: {
        model: "sellout",
        progressPct: 27.25,
        targetCook: "8692600",
        raisedCook: "1371322.816166949",
      },
      floorPriceCook: null,
      royaltyPct: 6.5,
      link: "https://momoswap.fun/nft/8TWT6i5Cpdp81LHmSvZGoAK2AxrVv6D5C5iG51dZ4LF5",
    });
  });
});

describe("spendCap", () => {
  it("adds the slippage and rounds up", () => {
    expect(spendCap(10_000n, 100)).toBe(10_100n);
    expect(spendCap(1n, 1)).toBe(2n);
    expect(spendCap(10_000n, 0)).toBe(10_000n);
  });
});

describe("requestBudget", () => {
  it("holds the spend to the deposits the build states", () => {
    const deposits = {
      itemDepositLamports: "19700000",
      requestRentLamports: "1600000",
      queueRentLamports: "10500000",
    };
    expect(requestBudget(1_000n, deposits).native).toBe(
      NATIVE_FEE_ALLOWANCE + 31_800_000n + 1_000n,
    );
  });

  it("falls back to the allowance when the build states none, or nonsense", () => {
    expect(requestBudget(1_000n).native).toBe(
      NATIVE_FEE_ALLOWANCE + NFT_REQUEST_DEPOSIT_ALLOWANCE + 1_000n,
    );
    const bad = { itemDepositLamports: "?", requestRentLamports: "1", queueRentLamports: "1" };
    expect(requestBudget(1_000n, bad).native).toBe(
      NATIVE_FEE_ALLOWANCE + NFT_REQUEST_DEPOSIT_ALLOWANCE + 1_000n,
    );
  });
});

describe("settleBudget / refundBudget", () => {
  const WCOOK = "So11111111111111111111111111111111111111112";
  const ITEM = "76peo3d2i7MiELMvZFTZLc2g7qT3df7vtccBuY6ms1dw";

  it("lets a settler front the item's rent, and requires the item only when the request is ours", () => {
    expect(settleBudget(null)).toEqual({ native: NATIVE_FEE_ALLOWANCE + NFT_ITEM_RENT_ALLOWANCE });
    expect(settleBudget(ITEM).receive).toEqual({ mint: ITEM, min: 1n });
  });

  it("lets a refund cost only fees, and requires our money back only when the request is ours", () => {
    expect(refundBudget(null)).toEqual({ native: NATIVE_FEE_ALLOWANCE });
    expect(refundBudget(5_000n).receive).toEqual({ mint: WCOOK, min: 5_000n });
  });
});

describe("nftSimError", () => {
  it("names the program's error and says what to do", () => {
    const e = nftSimError("NFT mint", { InstructionError: [2, { Custom: 6031 }] }, null);
    expect(e.code).toBe(6031);
    expect(e.message).toBe(
      "NFT mint would fail: Price moved beyond the limit you accepted (SlippageExceeded)",
    );
    expect(e.hint).toMatch(/raise slippageBps/);
  });

  it("falls back to the program's own message for codes without advice", () => {
    expect(nftSimError("x", { InstructionError: [0, { Custom: 6023 }] }, null).message).toMatch(
      /Nothing to claim/,
    );
  });

  it("reads insufficient funds", () => {
    expect(
      nftSimError("x", { InstructionError: [0, { Custom: 1 }] }, ["insufficient lamports"]).message,
    ).toMatch(/insufficient funds/);
  });
});

describe("planNftDrop", () => {
  const terms = {
    tradeFeeBps: 200,
    maxCreatorRoyaltyBps: 1_000,
    maxStartAheadSeconds: 30 * 86_400,
    targetGraduation: true,
    targetMaxSupply: 10_000,
  };
  const base = { name: "Cookie Chads", symbol: "chads", artDir: "/x", startPriceCook: 150 };

  it("previews the curve, raise and floor the launch would create", () => {
    const p = planNftDrop({ ...base, floorLockPct: 25 }, 444, terms, NOW);
    expect(p.symbol).toBe("CHADS");
    expect(p.reserves).toEqual({
      virtualPaymentReserve: 130_441_176_470_223n,
      virtualNftReserve: 888n,
    });
    expect(p.preview).toMatchObject({
      items: 444,
      firstItemCook: "149.999999999",
      raiseAtSelloutCook: "130441.176470553",
      graduation: { at: "sell-out" },
      royaltyPct: 5,
    });
    expect(p.targetRaw).toBeNull();
    expect(p.endTs - p.launchTs).toBe(86_400);
  });

  it("resolves a graduation target the way the program checks it", () => {
    const p = planNftDrop({ ...base, graduationTargetPct: 75 }, 444, terms, NOW);
    expect(p.targetBps).toBe(7_500);
    expect(p.targetRaw).toBe(97_830_882_352_668n);
    expect(p.preview.graduation).toMatchObject({ afterItems: 381 });
  });

  it("refuses what the launchpad would refuse, before anything is uploaded", () => {
    expect(() => planNftDrop({ ...base, name: "x".repeat(25) }, 10, terms, NOW)).toThrow(
      /1–24 bytes/,
    );
    expect(() => planNftDrop({ ...base, symbol: "CH-ADS" }, 10, terms, NOW)).toThrow(
      /letters or digits/,
    );
    expect(() => planNftDrop({ ...base, royaltyPct: 11 }, 10, terms, NOW)).toThrow(
      /royaltyPct must be between 0 and 10/,
    );
    expect(() => planNftDrop({ ...base, graduationTargetPct: 40 }, 10, terms, NOW)).toThrow(
      /between 50 and 99.99/,
    );
    expect(() =>
      planNftDrop(
        { ...base, graduationTargetPct: 75 },
        10,
        { ...terms, targetGraduation: false },
        NOW,
      ),
    ).toThrow(/not enabled/);
    expect(() =>
      planNftDrop(
        { ...base, launchAt: new Date((NOW + 31 * 86_400) * 1000).toISOString() },
        10,
        terms,
        NOW,
      ),
    ).toThrow(/at most 30 days ahead/);
    expect(() =>
      planNftDrop(
        {
          ...base,
          allowlist: ["9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni"],
          allowlistHours: 24,
        },
        10,
        terms,
        NOW,
      ),
    ).toThrow(/allowlist phase must end before/);
    expect(() => planNftDrop({ ...base, partnerSharePct: 10 }, 10, terms, NOW)).toThrow(
      /needs a royaltyPartner/,
    );
  });
});
