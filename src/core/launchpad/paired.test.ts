import { describe, expect, it } from "vitest";

import fixture from "./__fixtures__/paired-svm-trades.json" with { type: "json" };
import { CookieMcpError } from "../errors";
import type { LaunchpadConfig, LaunchpadPool, PairAsset } from "./api";
import { quoteBuy } from "./curve";
import {
  assertPairedFloor,
  isPairedPool,
  launchpadRouteMessage,
  mapPoolView,
  pairedDevBuyCookForSupplyPct,
  pairedHoldingAction,
  pairedPhaseOf,
  pairedView,
  resolvePairedLaunch,
} from "./index";
import {
  grossUpForTax,
  netForTokens,
  pairedBuyAmounts,
  pairedSeedCappedAtTarget,
  pairedTransferTax,
  poolTimeIso,
  quotePairedBuy,
  quotePairedSell,
  taxPct,
  withSlippage,
  type PairedCurveState,
} from "./paired";

// Trades recorded by running the PROGRAM (anchor-launchpad-momoswap's litesvm harness, see the
// fixture's `source`): the pool state right before each trade and the event it emitted. Copied from
// momoswap-backend, whose quote this module ports — so both ports answer to the chain, not each other.
interface Case {
  tag: string;
  side: "buy" | "sell";
  taxBps: number;
  state: Record<string, string | number>;
  onChain: Record<string, string>;
}
const cases = (fixture as unknown as { cases: Case[] }).cases;
const stateOf = (c: Case): PairedCurveState => ({
  virtualPaymentReserve: String(c.state.virtualPaymentReserve),
  virtualTokenReserve: String(c.state.virtualTokenReserve),
  tokensSold: String(c.state.tokensSold),
  paymentRaisedNet: String(c.state.paymentRaisedNet),
  tradeFeeBps: Number(c.state.tradeFeeBps),
  graduationTarget: String(c.state.graduationTarget),
  saleTokenSupply: String(c.state.saleTokenSupply),
  minBuy: c.state.minBuy === undefined ? null : String(c.state.minBuy),
});

describe("paired quote = the program, on every recorded trade", () => {
  it("covers every tier, buys, sells, target crossings and the dust gap", () => {
    expect(cases).toHaveLength(18);
    for (const bps of [100, 200, 300])
      expect(cases.filter((c) => c.taxBps === bps)).toHaveLength(6);
    expect(cases.filter((c) => c.tag.endsWith("-cross"))).toHaveLength(3);
    expect(cases.filter((c) => c.tag.endsWith("-dust"))).toHaveLength(3);
  });

  for (const c of cases.filter((x) => x.side === "buy")) {
    it(`${c.tag}: charged, netted, sent and delivered exactly as the program did`, () => {
      const q = quotePairedBuy(stateOf(c), BigInt(c.onChain.offered!), c.taxBps, 0);
      expect(q.amountInUsed.toString()).toBe(c.onChain.paymentIn);
      expect(q.curvePayment.toString()).toBe(c.onChain.netPayment);
      expect(q.curveTokens.toString()).toBe(c.onChain.tokensOut);
      expect(q.amountOut.toString()).toBe(c.onChain.tokensReceived);
      expect(q.taxAmount).toBe(BigInt(c.onChain.tokensOut!) - BigInt(c.onChain.tokensReceived!));
      expect(q.feeRaw).toBe(BigInt(c.onChain.paymentIn!) - BigInt(c.onChain.netPayment!));
      expect(q.minOut.toString()).toBe(c.onChain.tokensReceived); // 0 slippage = exactly delivered
    });
  }

  for (const c of cases.filter((x) => x.side === "sell")) {
    it(`${c.tag}: priced on what reached the vault, paid exactly as the program did`, () => {
      const q = quotePairedSell(stateOf(c), BigInt(c.onChain.tokensIn!), c.taxBps, 0);
      expect(q.curveTokens.toString()).toBe(c.onChain.tokensReceived);
      expect(q.taxAmount).toBe(BigInt(c.onChain.tokensIn!) - BigInt(c.onChain.tokensReceived!));
      expect(q.amountOut.toString()).toBe(c.onChain.paymentOut);
      expect(q.feeRaw.toString()).toBe(c.onChain.fee);
    });
  }

  it("a crossing buy is charged less than offered and nets exactly the target", () => {
    for (const c of cases.filter((x) => x.tag.endsWith("-cross"))) {
      const q = quotePairedBuy(stateOf(c), BigInt(c.onChain.offered!), c.taxBps, 0);
      expect(q.amountInUsed).toBeLessThan(BigInt(c.onChain.offered!));
      expect(BigInt(c.state.paymentRaisedNet) + q.curvePayment).toBe(
        BigInt(c.state.graduationTarget),
      );
    }
  });
});

describe("paired quote pieces", () => {
  it("tax is ceil(amount × bps / 10000), 0 for nothing", () => {
    expect(pairedTransferTax(34_361_619_746_712n, 100)).toBe(343_616_197_468n);
    expect(pairedTransferTax(1n, 100)).toBe(1n);
    expect(pairedTransferTax(0n, 300)).toBe(0n);
  });

  it("gross-up is the smallest amount that still delivers the net", () => {
    for (const bps of [100, 200, 300]) {
      const g = grossUpForTax(1_000_000n, bps);
      expect(g - pairedTransferTax(g, bps)).toBeGreaterThanOrEqual(1_000_000n);
      expect(g - 1n - pairedTransferTax(g - 1n, bps)).toBeLessThan(1_000_000n);
    }
  });

  it("net_for_tokens is the smallest net payment that buys the tokens", () => {
    const x = 30_000_000_000n;
    const y = 1_073_000_000_000_000n;
    const n = netForTokens(x, y, 2n);
    const out = (p: bigint) => y - (x * y + (x + p) - 1n) / (x + p);
    expect(out(n)).toBeGreaterThanOrEqual(2n);
    expect(out(n - 1n)).toBeLessThan(2n);
  });

  it("a capped buy pays the smallest payment that nets exactly the cap", () => {
    const { payment, net } = pairedBuyAmounts(50_000_000_000n, 75, 1_234_567_891n);
    expect(net).toBe(1_234_567_891n);
    expect(payment - 1n - ((payment - 1n) * 75n) / 10_000n).toBeLessThan(1_234_567_891n);
  });

  it("slippage floors the amount", () => {
    expect(withSlippage(10_000n, 100)).toBe(9_900n);
    expect(withSlippage(999n, 100)).toBe(989n);
  });

  it("refuses a buy once the target is reached, with a market hint", () => {
    const c = cases[0]!;
    const full = { ...stateOf(c), paymentRaisedNet: String(c.state.graduationTarget) };
    expect(() => quotePairedBuy(full, 1_000_000_000n, 100)).toThrow(/graduation target/);
  });

  it("refuses to sell more than the curve sold", () => {
    expect(() => quotePairedSell(stateOf(cases[0]!), 10n ** 18n, 100)).toThrow(/more tokens/);
  });
});

describe("pairedSeedCappedAtTarget", () => {
  const cfg = {
    graduationTarget: "1000000000000000",
    defaultVirtualPaymentReserve: "30000000000000",
    defaultVirtualTokenReserve: "1073000000000000",
    defaultTotalSupply: "1000000000000000",
    creatorVestBps: 2000,
    graduationFee: "0",
  };
  it("is null when the curve is not published", () => {
    expect(
      pairedSeedCappedAtTarget({ ...cfg, defaultVirtualPaymentReserve: undefined }, 100),
    ).toBeNull();
  });
  it("is monotone in the tax: a higher tier needs a bigger seed", () => {
    const capped = [100, 300, 1000, 5000].map((t) => pairedSeedCappedAtTarget(cfg, t));
    const first = capped.indexOf(true);
    if (first >= 0) expect(capped.slice(first).every(Boolean)).toBe(true);
  });
});

describe("helpers", () => {
  it("poolTimeIso: i64::MAX (a paired end_ts) is no deadline, not a crash", () => {
    expect(poolTimeIso(9223372036854776000)).toBeNull();
    expect(poolTimeIso(0)).toBeNull();
    expect(poolTimeIso(1794853683)).toBe("2026-11-16T18:28:03.000Z");
  });
  it("taxPct", () => {
    expect(taxPct(300)).toBe("3%");
    expect(taxPct(150)).toBe("1.5%");
  });
});

// --- pool-level -----------------------------------------------------------------------------------

// Shape of GET /v1/launchpad/pools for the live paired pool KITCHEN (5HEJTSea…), set back on its curve.
const PAIRED: LaunchpadPool = {
  pubkey: "5HEJTSea7AmzapHAznK5pEpWNBQiHdtJ3XgxFLuZWNXj",
  creator: "FFWfqNZGQKun8d1iePAnqkrob359Do2qXwV7CqvF4wq2",
  poolId: "1",
  name: "Kitchen",
  symbol: "KITCHEN",
  uri: "https://ipfs.momoswap.fun/ipfs/x",
  tokenMint: "AsonMnqP367GxcNun4dfpAPQrhJK4NBeGheC7GGvmomo",
  paymentMint: "So11111111111111111111111111111111111111112",
  tokenVault: "11111111111111111111111111111111",
  paymentVault: "11111111111111111111111111111111",
  launchTs: 1794853683,
  endTs: 9223372036854776000,
  durationSecs: 0,
  expiryMode: "fair",
  migratable: true,
  antiSnipe: false,
  state: "pairedOpen",
  status: "live",
  minBuy: "0",
  maxBuyPerWallet: "0",
  maxPaymentRaise: "0",
  totalTokenSupply: "1000000000000000",
  saleTokenSupply: "800000000000000",
  virtualPaymentReserve: "30000000000000",
  virtualTokenReserve: "1073000000000000",
  tokensSold: "100000000000000",
  totalActiveShares: "0",
  paymentRaisedNet: "500000000000000",
  paymentRaisedGross: "505000000000000",
  participantCount: "5",
  expiryLiquidity: "0",
  totalExpiryShares: "0",
  settlementRootSet: false,
  graduatedAt: 0,
  creatorVestAmount: "0",
  creatorVestClaimed: "0",
  creatorVestStart: 0,
  creatorVestEnd: 0,
  graduationTarget: "1000000000000000",
  kind: "paired",
  taxBps: 300,
  pair: { mint: "C4yVWDrwXeEUapmw3BkvktHBxCSsM8MfJ3aPVuFonFi5", symbol: "COOKHOUSE", decimals: 6 },
  phase: "live",
};

describe("paired pools in the pool view", () => {
  it("recognises a paired pool by kind, or by its on-chain state", () => {
    expect(isPairedPool(PAIRED)).toBe(true);
    expect(isPairedPool({ kind: undefined, state: "pairedOpen" })).toBe(true);
    expect(isPairedPool({ kind: "standard", state: "open" })).toBe(false);
  });

  it("maps a paired pool without throwing on its i64::MAX end (live regression)", () => {
    const v = mapPoolView(PAIRED, 6);
    expect(v.endsAt).toBeNull();
    expect(v.paired).toMatchObject({
      phase: "live",
      holderTaxPct: "3%",
      pairAsset: { symbol: "COOKHOUSE" },
    });
    expect(v.paired?.note).toMatch(/launchpad_buy/);
  });

  it("a standard pool has no paired block", () => {
    expect(
      mapPoolView({ ...PAIRED, kind: "standard", state: "open", endTs: 1794853683 }, 6).paired,
    ).toBeUndefined();
  });

  it("phase: the API's when given, else derived (target reached → migrating)", () => {
    expect(pairedPhaseOf({ ...PAIRED, phase: "soon" })).toBe("soon");
    expect(
      pairedPhaseOf({ ...PAIRED, phase: null, paymentRaisedNet: PAIRED.graduationTarget }),
    ).toBe("migrating");
    expect(pairedPhaseOf({ ...PAIRED, phase: null, status: "graduated" })).toBe("graduated");
    expect(pairedView({ ...PAIRED, phase: "migrating" })?.note).toMatch(/migrating/);
  });

  it("route message sends a curve token to the launchpad tools and a migrating one to wait", () => {
    expect(launchpadRouteMessage({ ...PAIRED, status: "live" })?.hint).toMatch(/launchpad_buy/);
    expect(
      launchpadRouteMessage({ ...PAIRED, status: "graduated", phase: "migrating" })?.error,
    ).toMatch(/migrating/);
    expect(
      launchpadRouteMessage({ ...PAIRED, status: "graduated", phase: "graduated" }),
    ).toBeNull();
  });

  it("holding actions follow the phase", () => {
    expect(pairedHoldingAction("live").tool).toBe("launchpad_sell");
    expect(pairedHoldingAction("graduated").tool).toBe("trade");
    expect(pairedHoldingAction("migrating").tool).toBeNull();
  });
});

describe("resolvePairedLaunch", () => {
  const view = {
    taxTiers: [100, 200, 300],
    assets: [
      { mint: "So11111111111111111111111111111111111111112", symbol: "COOK", decimals: 9 },
      { mint: "EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz", symbol: "bCOOK", decimals: 9 },
    ] as PairAsset[],
  };
  it("matches a symbol case-insensitively or a mint exactly", () => {
    expect(resolvePairedLaunch({ pairAsset: "bcook", holderTaxPct: 2 }, view)).toMatchObject({
      asset: { symbol: "bCOOK" },
      taxBps: 200,
    });
    expect(
      resolvePairedLaunch(
        { pairAsset: "So11111111111111111111111111111111111111112", holderTaxPct: 1 },
        view,
      ).asset.symbol,
    ).toBe("COOK");
  });
  it("refuses an unlisted asset, a missing half, an off-tier tax and a capped tier", () => {
    expect(() => resolvePairedLaunch({ pairAsset: "USDC", holderTaxPct: 1 }, view)).toThrow(
      /not an active/,
    );
    expect(() => resolvePairedLaunch({ pairAsset: "COOK" }, view)).toThrow(/holderTaxPct/);
    expect(() => resolvePairedLaunch({ holderTaxPct: 1 }, view)).toThrow(/pairAsset/);
    expect(() => resolvePairedLaunch({ pairAsset: "COOK", holderTaxPct: 2.5 }, view)).toThrow(
      /tiers/,
    );
    expect(() => resolvePairedLaunch({ pairAsset: "COOK", holderTaxPct: 3 }, view, [300])).toThrow(
      /not available/,
    );
  });
});

describe("pairedDevBuyCookForSupplyPct", () => {
  const cfg = {
    defaultTotalSupply: "1000000000000000",
    defaultSaleSupply: "800000000000000",
    defaultVirtualPaymentReserve: "30000000000000",
    defaultVirtualTokenReserve: "1073000000000000",
    tradeFeeBps: 100,
  } as LaunchpadConfig;
  it("buys enough that the buyer still holds the share after the tax", () => {
    const pay = pairedDevBuyCookForSupplyPct(cfg, 1, 300);
    const net = pay - (pay * 100n) / 10_000n;
    const curve = {
      virtualPaymentReserve: cfg.defaultVirtualPaymentReserve!,
      virtualTokenReserve: cfg.defaultVirtualTokenReserve!,
      tokensSold: "0",
      paymentRaisedNet: "0",
    };
    const sent = quoteBuy(curve, net);
    expect(sent - pairedTransferTax(sent, 300)).toBeGreaterThanOrEqual(10_000_000_000_000n); // 1%
  });
});

describe("assertPairedFloor", () => {
  it("accepts the floor we asked for, or a build that echoes none", () => {
    expect(() => assertPairedFloor({ quote: { minOut: "100" } }, 100n, "buy")).not.toThrow();
    expect(() => assertPairedFloor({}, 100n, "buy")).not.toThrow();
  });
  it("refuses a build carrying any other floor", () => {
    expect(() => assertPairedFloor({ quote: { minOut: "1" } }, 100n, "buy")).toThrow(
      CookieMcpError,
    );
  });
});
