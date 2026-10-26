import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  applyHaircut,
  borrowRateBps,
  borrowRatePerSlot,
  currentBorrowedAmount,
  evaluateObligation,
  healthFactor,
  liquidityToShares,
  marketValue,
  maxAdditionalBorrow,
  mulDiv,
  permitsBorrow,
  projectAccrual,
  sharesToLiquidity,
  supplyHeadroom,
  supplyRateBps,
  totalLiquidity,
  utilizationBps,
} from "./math";
import { WAD, type DecodedOracle, type DecodedReserve, type ReserveConfig } from "./program";

const K = (n: number) => new PublicKey(Buffer.alloc(32, n));
const ONE = 1_000_000_000n; // 9 decimals

const CONFIG: ReserveConfig = {
  loanToValueBps: 5500,
  liquidationThresholdBps: 6500,
  liquidationBonusBps: 800,
  closeFactorBps: 5000,
  collateralHaircutBps: 500,
  optimalUtilizationBps: 6000,
  minBorrowRateBps: 200,
  optimalBorrowRateBps: 1000,
  maxBorrowRateBps: 9000,
  reserveFactorBps: 1500,
  originationFeeBps: 15,
  supplyCap: 0n,
  borrowCap: 0n,
  perWalletSupplyCap: 0n,
  borrowEnabled: true,
  collateralEnabled: true,
  isolated: false,
  slotsPerYear: 69_313_098n,
};

function reserve(over: Partial<DecodedReserve> = {}): DecodedReserve {
  return {
    market: K(1),
    liquidityMint: K(2),
    liquidityVault: K(3),
    shareMint: K(4),
    oracle: K(5),
    liquidityDecimals: 9,
    availableLiquidity: 400n * ONE,
    shareMintSupply: 1000n * ONE,
    borrowedPrincipal: 600n * ONE,
    borrowIndex: WAD,
    lastUpdateSlot: 100n,
    accruedFees: 0n,
    config: { ...CONFIG },
    pending: { config: { ...CONFIG }, eta: 0n },
    ...over,
  };
}

function oracle(rate: bigint, health: DecodedOracle["health"] = "healthy"): DecodedOracle {
  return {
    market: K(1),
    mint: K(2),
    sourceKind: "unitOfAccount",
    sourceProgram: K(0),
    sourceAccount: K(0),
    maxWithdrawalFeeBps: 0,
    grossRate: rate,
    effectiveRate: rate,
    withdrawalFeeBps: 0,
    referenceSlot: 0n,
    health,
    lastMovedBps: 0n,
    lastRefreshSlot: 0n,
  };
}

describe("mulDiv rounding", () => {
  it("floors by default and ceils on request only when inexact", () => {
    expect(mulDiv(7n, 1n, 2n, "down")).toBe(3n);
    expect(mulDiv(7n, 1n, 2n, "up")).toBe(4n);
    expect(mulDiv(8n, 1n, 2n, "up")).toBe(4n);
  });
});

describe("reserve accounting", () => {
  it("debt ceils principal × index", () => {
    const r = reserve({ borrowedPrincipal: 3n, borrowIndex: WAD + WAD / 3n });
    expect(currentBorrowedAmount(r)).toBe(4n); // 3 × 1.333… = 3.999… → 4
  });

  it("utilization and the kinked borrow rate", () => {
    // 600 borrowed of 1000 gross = 60% = exactly the kink → optimal rate.
    expect(utilizationBps(reserve())).toBe(6000n);
    expect(borrowRateBps(reserve())).toBe(1000n);
    // Below the kink: linear from min.
    expect(
      borrowRateBps(reserve({ availableLiquidity: 700n * ONE, borrowedPrincipal: 300n * ONE })),
    ).toBe(200n + ((1000n - 200n) * 3000n) / 6000n);
    // Above the kink: linear from optimal to max at 100%.
    expect(borrowRateBps(reserve({ availableLiquidity: 0n, borrowedPrincipal: 600n * ONE }))).toBe(
      9000n,
    );
    // Empty reserve: utilization 0 → min rate.
    expect(borrowRateBps(reserve({ availableLiquidity: 0n, borrowedPrincipal: 0n }))).toBe(200n);
  });

  it("supply rate = borrow rate × utilization × (1 − reserve factor)", () => {
    // 10% × 60% × 85% = 5.1%
    expect(supplyRateBps(reserve())).toBe(510n);
  });

  it("projects the index like accrue_interest and splits the fee", () => {
    const r = reserve();
    const perSlot = borrowRatePerSlot(r);
    expect(perSlot).toBe((1000n * WAD) / (10_000n * 69_313_098n));
    const slot = r.lastUpdateSlot + 69_313_098n; // one year
    const p = projectAccrual(r, slot);
    expect(p.lastUpdateSlot).toBe(slot);
    // ≈ 10% simple growth (per-slot rate is floored, so a hair under).
    expect(p.borrowIndex).toBeGreaterThan(WAD + (WAD * 999n) / 10_000n);
    expect(p.borrowIndex).toBeLessThanOrEqual(WAD + WAD / 10n);
    const interest = currentBorrowedAmount(p) - currentBorrowedAmount(r);
    expect(p.accruedFees).toBe((interest * 1500n) / 10_000n);
    // Suppliers see the other 85%.
    expect(totalLiquidity(p) - totalLiquidity(r)).toBe(interest - p.accruedFees);
    // Pure: the input is untouched; a past slot is a no-op.
    expect(r.borrowIndex).toBe(WAD);
    expect(projectAccrual(r, 50n)).toBe(r);
  });

  it("does not move the index on a reserve with no debt", () => {
    const r = reserve({ borrowedPrincipal: 0n });
    const p = projectAccrual(r, 10_000_000n);
    expect(p.borrowIndex).toBe(WAD);
    expect(p.lastUpdateSlot).toBe(10_000_000n);
  });

  it("shares ⇄ liquidity use total liquidity net of fees, floor for the user", () => {
    const r = reserve({ accruedFees: 10n * ONE }); // total = 400 + 600 − 10 = 990 per 1000 shares
    expect(sharesToLiquidity(r, ONE, "down")).toBe(990_000_000n);
    expect(liquidityToShares(r, 990_000_000n, "down")).toBe(ONE);
    expect(liquidityToShares(r, 1n, "up")).toBe(2n); // 1/0.99 rounds up
    // First depositor: 1:1.
    expect(liquidityToShares(reserve({ shareMintSupply: 0n }), 5n, "down")).toBe(5n);
  });

  it("supply headroom honours 0 = unlimited", () => {
    expect(supplyHeadroom(reserve(), 0n)).toEqual({ reserveRoom: null, walletRoom: null });
    const capped = reserve({
      config: { ...CONFIG, supplyCap: 1100n * ONE, perWalletSupplyCap: 50n * ONE },
    });
    expect(supplyHeadroom(capped, 20n * ONE)).toEqual({
      reserveRoom: 100n * ONE,
      walletRoom: 30n * ONE,
    });
    expect(supplyHeadroom(capped, 70n * ONE).walletRoom).toBe(0n);
  });
});

describe("obligation health", () => {
  const COLLATERAL = K(10);
  const DEBT = K(11);
  // bCOOK-like collateral at 1.4 COOK each (index 1, 1:1 shares); COOK-like debt at 1.
  const collateral = reserve({ availableLiquidity: 1000n * ONE, borrowedPrincipal: 0n });
  const debt = reserve();
  const lookup = (k: PublicKey) =>
    k.equals(COLLATERAL)
      ? { reserve: collateral, oracle: oracle((14n * WAD) / 10n) }
      : { reserve: debt, oracle: oracle(WAD) };

  it("mirrors refresh_obligation: haircut, LTV and liquidation threshold on face value", () => {
    const h = evaluateObligation(
      {
        deposits: [{ reserve: COLLATERAL, depositedShares: 100n * ONE, marketValue: 0n }],
        borrows: [{ reserve: DEBT, borrowedPrincipal: 50n * ONE, marketValue: 0n }],
      },
      lookup,
    );
    const face = 140n * WAD;
    expect(h.depositedValue).toBe(face);
    expect(h.effectiveCollateralValue).toBe(applyHaircut(face, 500)); // 133
    expect(h.allowedBorrowValue).toBe((applyHaircut(face, 500) * 5500n) / 10_000n); // 73.15
    expect(h.unhealthyBorrowValue).toBe((applyHaircut(face, 500) * 6500n) / 10_000n); // 86.45
    expect(h.borrowedValue).toBe(50n * WAD);
    expect(h.healthFactorBps).toBe(17_290n);
    expect(healthFactor(h)).toBeCloseTo(1.729, 6);
    expect(h.liquidatable).toBe(false);
    expect(h.deposits[0]!.liquidity).toBe(100n * ONE);
    expect(h.borrows[0]!.debt).toBe(50n * ONE);
  });

  it("flags a liquidatable position and stressed prices", () => {
    const h = evaluateObligation(
      {
        deposits: [{ reserve: COLLATERAL, depositedShares: 100n * ONE, marketValue: 0n }],
        borrows: [{ reserve: DEBT, borrowedPrincipal: 90n * ONE, marketValue: 0n }],
      },
      (k) =>
        k.equals(COLLATERAL)
          ? { reserve: collateral, oracle: oracle((14n * WAD) / 10n, "borrowFrozen") }
          : lookup(k),
    );
    expect(h.liquidatable).toBe(true);
    expect(h.pricesStressed).toBe(true);
    expect(healthFactor(h)!).toBeLessThan(1);
  });

  it("stresses only an oracle that will not permit borrowing (rateWarning does)", () => {
    const stressedWith = (health: Parameters<typeof permitsBorrow>[0], onDebt = false) =>
      evaluateObligation(
        {
          deposits: [{ reserve: COLLATERAL, depositedShares: 100n * ONE, marketValue: 0n }],
          borrows: [{ reserve: DEBT, borrowedPrincipal: ONE, marketValue: 0n }],
        },
        (k) =>
          k.equals(onDebt ? DEBT : COLLATERAL)
            ? { ...lookup(k), oracle: { ...lookup(k).oracle, health } }
            : lookup(k),
      ).pricesStressed;
    expect(stressedWith("healthy")).toBe(false);
    expect(stressedWith("rateWarning")).toBe(false);
    expect(stressedWith("borrowFrozen")).toBe(true);
    expect(stressedWith("emergency")).toBe(true);
    expect(stressedWith("bootstrapping")).toBe(true);
    // The program reads the oracles of borrows too, not only collateral.
    expect(stressedWith("emergency", true)).toBe(true);
  });

  it("has no health factor without debt", () => {
    const h = evaluateObligation(
      { deposits: [{ reserve: COLLATERAL, depositedShares: ONE, marketValue: 0n }], borrows: [] },
      lookup,
    );
    expect(h.healthFactorBps).toBeNull();
    expect(healthFactor(h)).toBeNull();
    expect(h.liquidatable).toBe(false);
  });

  it("maxAdditionalBorrow is the LTV headroom, bounded by liquidity and the borrow cap", () => {
    const h = evaluateObligation(
      {
        deposits: [{ reserve: COLLATERAL, depositedShares: 100n * ONE, marketValue: 0n }],
        borrows: [{ reserve: DEBT, borrowedPrincipal: 50n * ONE, marketValue: 0n }],
      },
      lookup,
    );
    expect(maxAdditionalBorrow(h, debt, oracle(WAD))).toBe(23_150_000_000n); // 73.15 − 50
    expect(maxAdditionalBorrow(h, reserve({ availableLiquidity: 5n * ONE }), oracle(WAD))).toBe(
      5n * ONE,
    );
    const capped = reserve({ config: { ...CONFIG, borrowCap: 610n * ONE } }); // 600 owed → 10 room
    expect(maxAdditionalBorrow(h, capped, oracle(WAD))).toBe(10n * ONE);
    expect(
      maxAdditionalBorrow({ allowedBorrowValue: 1n, borrowedValue: 2n }, debt, oracle(WAD)),
    ).toBe(0n);
  });

  it("marketValue scales by decimals and rounds as asked", () => {
    expect(marketValue(ONE, 9, (14n * WAD) / 10n, "down")).toBe((14n * WAD) / 10n);
    expect(marketValue(1n, 9, 1n, "up")).toBe(1n);
    expect(marketValue(1n, 9, 1n, "down")).toBe(0n);
  });
});
