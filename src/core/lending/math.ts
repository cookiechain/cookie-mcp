// Pure mirror of the Aera program's accounting (`state/reserve.rs`, `state/obligation.rs`,
// `instructions/refresh_obligation.rs`, `math.rs`): interest projection, share ⇄ liquidity, rates,
// and obligation health. Every helper takes decoded accounts and BigInts, so it is unit-testable and
// has no RPC dependency. Rounding follows the program exactly (user-favourable floors, owed ceils),
// because a flow that estimates on the wrong side would promise what the handler then refuses.
import type { PublicKey } from "@solana/web3.js";

import {
  BPS,
  WAD,
  type DecodedObligation,
  type DecodedOracle,
  type DecodedReserve,
  type ReserveConfig,
} from "./program";

export type Rounding = "down" | "up";

export function mulDiv(a: bigint, b: bigint, den: bigint, rounding: Rounding): bigint {
  if (den <= 0n) throw new Error("division by zero");
  const p = a * b;
  const q = p / den;
  return rounding === "up" && p % den !== 0n ? q + 1n : q;
}

/** `Reserve::current_borrowed_amount` — ceil(principal × index / 1e18). */
export function currentBorrowedAmount(
  r: Pick<DecodedReserve, "borrowedPrincipal" | "borrowIndex">,
) {
  return mulDiv(r.borrowedPrincipal, r.borrowIndex, WAD, "up");
}

export function grossLiquidity(r: DecodedReserve): bigint {
  return r.availableLiquidity + currentBorrowedAmount(r);
}

/** What the shares are worth in total: available + owed − the protocol's accrued fees. */
export function totalLiquidity(r: DecodedReserve): bigint {
  return grossLiquidity(r) - r.accruedFees;
}

export function utilizationBps(r: DecodedReserve): bigint {
  const gross = grossLiquidity(r);
  return gross === 0n ? 0n : mulDiv(currentBorrowedAmount(r), BPS, gross, "down");
}

/** Kinked rate: min → optimal up to the kink, optimal → max above it. APR in bps. */
export function borrowRateBps(r: DecodedReserve): bigint {
  const u = utilizationBps(r);
  const c = r.config;
  const uOpt = BigInt(c.optimalUtilizationBps);
  if (u <= uOpt) {
    const range = BigInt(c.optimalBorrowRateBps - c.minBorrowRateBps);
    return BigInt(c.minBorrowRateBps) + mulDiv(range, u, uOpt, "down");
  }
  const range = BigInt(c.maxBorrowRateBps - c.optimalBorrowRateBps);
  return BigInt(c.optimalBorrowRateBps) + mulDiv(range, u - uOpt, BPS - uOpt, "down");
}

/** Supplier APR in bps: borrow rate × utilization × (1 − reserve factor). */
export function supplyRateBps(r: DecodedReserve): bigint {
  const afterUtil = mulDiv(borrowRateBps(r), utilizationBps(r), BPS, "down");
  return mulDiv(afterUtil, BPS - BigInt(r.config.reserveFactorBps), BPS, "down");
}

export function borrowRatePerSlot(r: DecodedReserve): bigint {
  return mulDiv(borrowRateBps(r), WAD, BPS * r.config.slotsPerYear, "down");
}

/**
 * `Reserve::accrue_interest` projected to `slot`: the index, the fee cut and the update slot the
 * reserve will hold once `accrue` lands there. Pure — returns a new reserve, never mutates.
 */
export function projectAccrual(r: DecodedReserve, slot: bigint): DecodedReserve {
  if (slot <= r.lastUpdateSlot) return r;
  const elapsed = slot - r.lastUpdateSlot;
  if (r.borrowedPrincipal === 0n) return { ...r, lastUpdateSlot: slot };
  const before = currentBorrowedAmount(r);
  const growth = WAD + borrowRatePerSlot(r) * elapsed;
  const borrowIndex = mulDiv(r.borrowIndex, growth, WAD, "down");
  const after = currentBorrowedAmount({ borrowedPrincipal: r.borrowedPrincipal, borrowIndex });
  const interest = after > before ? after - before : 0n;
  const fee = mulDiv(interest, BigInt(r.config.reserveFactorBps), BPS, "down");
  return { ...r, borrowIndex, accruedFees: r.accruedFees + fee, lastUpdateSlot: slot };
}

export function sharesToLiquidity(r: DecodedReserve, shares: bigint, rounding: Rounding): bigint {
  const supply = r.shareMintSupply > 0n ? r.shareMintSupply : 1n;
  return mulDiv(shares, totalLiquidity(r), supply, rounding);
}

export function liquidityToShares(
  r: DecodedReserve,
  liquidity: bigint,
  rounding: Rounding,
): bigint {
  if (r.shareMintSupply === 0n) return liquidity;
  const total = totalLiquidity(r) > 0n ? totalLiquidity(r) : 1n;
  return mulDiv(liquidity, r.shareMintSupply, total, rounding);
}

/** `math::market_value`: amount in base units × 1e18-scaled price ÷ 10^decimals → 1e18-scaled COOK. */
export function marketValue(
  amount: bigint,
  decimals: number,
  priceScaled: bigint,
  rounding: Rounding,
): bigint {
  return mulDiv(amount, priceScaled, 10n ** BigInt(decimals), rounding);
}

export function applyHaircut(value: bigint, haircutBps: number): bigint {
  return mulDiv(value, BPS - BigInt(haircutBps), BPS, "down");
}

export interface ReserveView {
  reserve: DecodedReserve;
  oracle: DecodedOracle;
}

export interface ObligationHealth {
  /** Face value of all collateral, 1e18-scaled COOK. */
  depositedValue: bigint;
  effectiveCollateralValue: bigint;
  allowedBorrowValue: bigint;
  unhealthyBorrowValue: bigint;
  borrowedValue: bigint;
  /** unhealthy / borrowed in bps; null when nothing is borrowed. 10000 = at the liquidation line. */
  healthFactorBps: bigint | null;
  liquidatable: boolean;
  pricesStressed: boolean;
  deposits: Array<{ reserve: PublicKey; shares: bigint; liquidity: bigint; value: bigint }>;
  borrows: Array<{ reserve: PublicKey; debt: bigint; value: bigint }>;
}

/**
 * `refresh_obligation` evaluated off-chain against reserves already projected to the target slot and
 * the oracles' last accepted rates. Returns what the on-chain refresh would write.
 */
export function evaluateObligation(
  ob: Pick<DecodedObligation, "deposits" | "borrows">,
  lookup: (reserve: PublicKey) => ReserveView,
): ObligationHealth {
  let depositedValue = 0n;
  let effectiveCollateralValue = 0n;
  let allowedBorrowValue = 0n;
  let unhealthyBorrowValue = 0n;
  let pricesStressed = false;
  const deposits = ob.deposits.map((d) => {
    const { reserve, oracle } = lookup(d.reserve);
    const liquidity = sharesToLiquidity(reserve, d.depositedShares, "down");
    const face = marketValue(liquidity, reserve.liquidityDecimals, oracle.effectiveRate, "down");
    const effective = applyHaircut(face, reserve.config.collateralHaircutBps);
    pricesStressed ||= oracle.health === "rateWarning";
    depositedValue += face;
    effectiveCollateralValue += effective;
    allowedBorrowValue += mulDiv(effective, BigInt(reserve.config.loanToValueBps), BPS, "down");
    unhealthyBorrowValue += mulDiv(
      effective,
      BigInt(reserve.config.liquidationThresholdBps),
      BPS,
      "down",
    );
    return { reserve: d.reserve, shares: d.depositedShares, liquidity, value: face };
  });
  let borrowedValue = 0n;
  const borrows = ob.borrows.map((b) => {
    const { reserve, oracle } = lookup(b.reserve);
    const debt = mulDiv(b.borrowedPrincipal, reserve.borrowIndex, WAD, "up");
    const value = marketValue(debt, reserve.liquidityDecimals, oracle.effectiveRate, "up");
    pricesStressed ||= oracle.health === "rateWarning";
    borrowedValue += value;
    return { reserve: b.reserve, debt, value };
  });
  return {
    depositedValue,
    effectiveCollateralValue,
    allowedBorrowValue,
    unhealthyBorrowValue,
    borrowedValue,
    healthFactorBps: borrowedValue === 0n ? null : (unhealthyBorrowValue * BPS) / borrowedValue,
    liquidatable: borrowedValue > unhealthyBorrowValue,
    pricesStressed,
    deposits,
    borrows,
  };
}

/** Health factor as a number (1.0 = liquidation line), or null with no debt. */
export function healthFactor(h: Pick<ObligationHealth, "healthFactorBps">): number | null {
  return h.healthFactorBps === null ? null : Number(h.healthFactorBps) / 10_000;
}

/**
 * The most liquidity one more `borrow` on `reserve` can take given `allowed − borrowed` headroom —
 * a floor of the value conversion, so it never overshoots what the handler accepts.
 */
export function maxAdditionalBorrow(
  h: Pick<ObligationHealth, "allowedBorrowValue" | "borrowedValue">,
  reserve: DecodedReserve,
  oracle: DecodedOracle,
): bigint {
  if (h.allowedBorrowValue <= h.borrowedValue || oracle.effectiveRate === 0n) return 0n;
  const headroom = h.allowedBorrowValue - h.borrowedValue;
  const byValue = mulDiv(
    headroom,
    10n ** BigInt(reserve.liquidityDecimals),
    oracle.effectiveRate,
    "down",
  );
  let cap = byValue < reserve.availableLiquidity ? byValue : reserve.availableLiquidity;
  if (reserve.config.borrowCap > 0n) {
    const owed = currentBorrowedAmount(reserve);
    const room = reserve.config.borrowCap > owed ? reserve.config.borrowCap - owed : 0n;
    if (room < cap) cap = room;
  }
  return cap;
}

/** Caps a supply against the reserve's supply cap and the wallet's per-wallet cap (0 = none). */
export function supplyHeadroom(
  reserve: DecodedReserve,
  alreadySupplied: bigint,
): { reserveRoom: bigint | null; walletRoom: bigint | null } {
  const c: ReserveConfig = reserve.config;
  const gross = grossLiquidity(reserve);
  const reserveRoom = c.supplyCap === 0n ? null : c.supplyCap > gross ? c.supplyCap - gross : 0n;
  const walletRoom =
    c.perWalletSupplyCap === 0n
      ? null
      : c.perWalletSupplyCap > alreadySupplied
        ? c.perWalletSupplyCap - alreadySupplied
        : 0n;
  return { reserveRoom, walletRoom };
}
