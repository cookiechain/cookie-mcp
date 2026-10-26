// Hand-encoded `aera` instructions + account decoders for the Aera money market (program
// `Aerafp…`). Pure: PublicKey/Buffer only, no Connection, so every derivation and byte layout is
// unit-testable with golden values.
//
// Why hand-encoded rather than an anchor Program: Aera ships no IDL — neither on-chain (the IDL PDA
// does not exist) nor in its repo — and has no backend that builds transactions. The instructions are
// small (a discriminator plus at most one u64), so the only thing an IDL would give us is the
// discriminators, which are Anchor's defaults (`sha256("global:<ix>")[..8]`,
// `sha256("account:<Name>")[..8]`) and pinned here by golden tests. Layouts are transcribed from the
// program's `state/*.rs` and must be re-diffed on every upgrade (`Global.version` is the tell).
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import { PROGRAM_IDS } from "../config";

export const LENDING_PROGRAM_ID = new PublicKey(PROGRAM_IDS.aera);

/** `BPFLoaderUpgradeab1e…` — owner of the ProgramData account the bCOOK oracle pins its source to. */
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const SEEDS = {
  global: Buffer.from("global"),
  market: Buffer.from("market"),
  reserve: Buffer.from("reserve"),
  oracle: Buffer.from("oracle"),
  obligation: Buffer.from("obligation"),
  obligationShareVault: Buffer.from("obligation_share_vault"),
  supplyPosition: Buffer.from("supply_position"),
  riskConfig: Buffer.from("risk_config"),
} as const;

export const IX_DISCRIMINATORS = {
  accrue: [23, 76, 128, 149, 229, 247, 72, 228],
  refreshOracle: [110, 168, 158, 3, 43, 46, 41, 91],
  refreshObligation: [33, 132, 147, 228, 151, 192, 72, 89],
  initObligation: [251, 10, 231, 76, 27, 11, 159, 96],
  supply: [81, 67, 116, 61, 250, 209, 5, 198],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  depositCollateral: [156, 131, 142, 116, 146, 247, 162, 120],
  withdrawCollateral: [115, 135, 168, 106, 139, 214, 138, 150],
  borrow: [228, 253, 131, 202, 207, 116, 89, 18],
  repay: [234, 103, 67, 82, 208, 234, 219, 166],
} as const;

export const ACCOUNT_DISCRIMINATORS = {
  global: [167, 232, 232, 177, 200, 108, 114, 127],
  market: [219, 190, 213, 55, 0, 227, 198, 154],
  reserve: [43, 242, 204, 202, 26, 247, 59, 127],
  obligation: [168, 206, 141, 106, 88, 76, 172, 167],
  oracleState: [97, 156, 157, 189, 194, 73, 8, 15],
  supplyPosition: [248, 221, 250, 222, 37, 167, 64, 209],
  riskConfig: [201, 119, 245, 244, 40, 27, 0, 31],
} as const;

/** `FIXED_POINT_SCALE` — borrow indexes and oracle rates are 1e18-scaled u128s. */
export const WAD = 10n ** 18n;
export const BPS = 10_000n;
/** `MAX_OBLIGATION_RESERVES` — the Vec capacity `Obligation` is allocated for. */
export const MAX_OBLIGATION_RESERVES = 4;

// --- PDAs ---------------------------------------------------------------------------------------

export function globalPda(): PublicKey {
  return PublicKey.findProgramAddressSync([SEEDS.global], LENDING_PROGRAM_ID)[0];
}

export function marketPda(marketId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(marketId);
  return PublicKey.findProgramAddressSync([SEEDS.market, id], LENDING_PROGRAM_ID)[0];
}

export function lendingReservePda(market: PublicKey, liquidityMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.reserve, market.toBuffer(), liquidityMint.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

export function oraclePda(market: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.oracle, market.toBuffer(), mint.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

/** `["obligation", market, owner]` — one borrower account per wallet per market. */
export function obligationPda(market: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.obligation, market.toBuffer(), owner.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

/** Where an obligation keeps the share tokens it holds as collateral. */
export function obligationShareVaultPda(reserve: PublicKey, obligation: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.obligationShareVault, reserve.toBuffer(), obligation.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

export function supplyPositionPda(reserve: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.supplyPosition, reserve.toBuffer(), owner.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

/**
 * `["risk_config", reserve]` — `borrow` REQUIRES this address even when no account lives there (an
 * absent config reads as "no per-wallet borrow cap"); the handler re-derives it and refuses any other.
 */
export function riskConfigPda(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEEDS.riskConfig, reserve.toBuffer()],
    LENDING_PROGRAM_ID,
  )[0];
}

/** The upgradeable loader's ProgramData account for `program` (the oracle's deployment pin). */
export function programDataAddress(program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
}

// --- Account decoders ---------------------------------------------------------------------------

function hasDisc(data: Buffer, disc: readonly number[]): boolean {
  return data.length >= 8 && disc.every((b, i) => data[i] === b);
}
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const i64 = (d: Buffer, o: number) => d.readBigInt64LE(o);
const u128 = (d: Buffer, o: number) => (d.readBigUInt64LE(o + 8) << 64n) | d.readBigUInt64LE(o);
const u16 = (d: Buffer, o: number) => d.readUInt16LE(o);

export interface DecodedGlobal {
  admin: PublicKey;
  feeDestination: PublicKey;
  paused: boolean;
  borrowPaused: boolean;
  paramTimelockSeconds: bigint;
  version: number;
}

export function decodeGlobal(data: Buffer): DecodedGlobal | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.global) || data.length < 84) return null;
  return {
    admin: pk(data, 8),
    feeDestination: pk(data, 40),
    paused: data[72] === 1,
    borrowPaused: data[73] === 1,
    paramTimelockSeconds: i64(data, 74),
    version: data[83]!,
  };
}

export interface DecodedMarket {
  global: PublicKey;
  marketId: bigint;
  quoteCurrencyMint: PublicKey;
  name: string;
}

export function decodeMarket(data: Buffer): DecodedMarket | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.market) || data.length < 85) return null;
  const len = data.readUInt32LE(80);
  if (data.length < 84 + len) return null;
  return {
    global: pk(data, 8),
    marketId: u64(data, 40),
    quoteCurrencyMint: pk(data, 48),
    name: data.subarray(84, 84 + len).toString("utf8"),
  };
}

export interface ReserveConfig {
  loanToValueBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  closeFactorBps: number;
  collateralHaircutBps: number;
  optimalUtilizationBps: number;
  minBorrowRateBps: number;
  optimalBorrowRateBps: number;
  maxBorrowRateBps: number;
  reserveFactorBps: number;
  originationFeeBps: number;
  /** 0 = unlimited (all three caps). */
  supplyCap: bigint;
  borrowCap: bigint;
  perWalletSupplyCap: bigint;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
  isolated: boolean;
  slotsPerYear: bigint;
}

/** `ReserveConfig` is 57 bytes; it appears twice in `Reserve` (live + pending). */
export const RESERVE_CONFIG_LEN = 57;

export function decodeReserveConfig(d: Buffer, o: number): ReserveConfig {
  return {
    loanToValueBps: u16(d, o),
    liquidationThresholdBps: u16(d, o + 2),
    liquidationBonusBps: u16(d, o + 4),
    closeFactorBps: u16(d, o + 6),
    collateralHaircutBps: u16(d, o + 8),
    optimalUtilizationBps: u16(d, o + 10),
    minBorrowRateBps: u16(d, o + 12),
    optimalBorrowRateBps: u16(d, o + 14),
    maxBorrowRateBps: u16(d, o + 16),
    reserveFactorBps: u16(d, o + 18),
    originationFeeBps: u16(d, o + 20),
    supplyCap: u64(d, o + 22),
    borrowCap: u64(d, o + 30),
    perWalletSupplyCap: u64(d, o + 38),
    borrowEnabled: d[o + 46] === 1,
    collateralEnabled: d[o + 47] === 1,
    isolated: d[o + 48] === 1,
    slotsPerYear: u64(d, o + 49),
  };
}

export interface DecodedReserve {
  market: PublicKey;
  liquidityMint: PublicKey;
  liquidityVault: PublicKey;
  shareMint: PublicKey;
  oracle: PublicKey;
  liquidityDecimals: number;
  /** Internal counter, NOT the vault balance (donations cannot move the share rate). */
  availableLiquidity: bigint;
  shareMintSupply: bigint;
  /** 1e18-scaled principal; debt = ceil(principal × borrowIndex / 1e18). */
  borrowedPrincipal: bigint;
  borrowIndex: bigint;
  lastUpdateSlot: bigint;
  accruedFees: bigint;
  config: ReserveConfig;
  pending: { config: ReserveConfig; eta: bigint };
}

/** Byte offsets after the 8-byte discriminator (pinned by `program.test.ts` against a live account). */
export const RESERVE_OFFSETS = {
  market: 8,
  liquidityMint: 40,
  liquidityVault: 72,
  shareMint: 104,
  oracle: 136,
  liquidityDecimals: 168,
  availableLiquidity: 169,
  shareMintSupply: 177,
  borrowedPrincipal: 185,
  borrowIndex: 201,
  lastUpdateSlot: 217,
  accruedFees: 225,
  config: 233,
  pendingConfig: 233 + RESERVE_CONFIG_LEN,
  pendingEta: 233 + 2 * RESERVE_CONFIG_LEN,
  bump: 233 + 2 * RESERVE_CONFIG_LEN + 8,
} as const;
export const RESERVE_LEN = RESERVE_OFFSETS.bump + 1; // 356

export function decodeReserve(data: Buffer): DecodedReserve | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.reserve) || data.length < RESERVE_LEN) return null;
  const O = RESERVE_OFFSETS;
  return {
    market: pk(data, O.market),
    liquidityMint: pk(data, O.liquidityMint),
    liquidityVault: pk(data, O.liquidityVault),
    shareMint: pk(data, O.shareMint),
    oracle: pk(data, O.oracle),
    liquidityDecimals: data[O.liquidityDecimals]!,
    availableLiquidity: u64(data, O.availableLiquidity),
    shareMintSupply: u64(data, O.shareMintSupply),
    borrowedPrincipal: u128(data, O.borrowedPrincipal),
    borrowIndex: u128(data, O.borrowIndex),
    lastUpdateSlot: u64(data, O.lastUpdateSlot),
    accruedFees: u64(data, O.accruedFees),
    config: decodeReserveConfig(data, O.config),
    pending: { config: decodeReserveConfig(data, O.pendingConfig), eta: i64(data, O.pendingEta) },
  };
}

export interface ObligationCollateral {
  reserve: PublicKey;
  depositedShares: bigint;
  /** Face value at the last refresh (1e18-scaled COOK). */
  marketValue: bigint;
}
export interface ObligationLiquidity {
  reserve: PublicKey;
  borrowedPrincipal: bigint;
  marketValue: bigint;
}
export interface DecodedObligation {
  market: PublicKey;
  owner: PublicKey;
  lastUpdateSlot: bigint;
  stale: boolean;
  pricesStressed: boolean;
  depositedValue: bigint;
  effectiveCollateralValue: bigint;
  borrowedValue: bigint;
  allowedBorrowValue: bigint;
  unhealthyBorrowValue: bigint;
  deposits: ObligationCollateral[];
  borrows: ObligationLiquidity[];
}

const OBLIGATION_HEAD = 162; // disc + 2 pubkeys + slot + 2 bools + 5 × u128
const COLLATERAL_ENTRY = 32 + 8 + 16;
const LIQUIDITY_ENTRY = 32 + 16 + 16;
export const OBLIGATION_LEN =
  OBLIGATION_HEAD +
  4 +
  MAX_OBLIGATION_RESERVES * COLLATERAL_ENTRY +
  4 +
  MAX_OBLIGATION_RESERVES * LIQUIDITY_ENTRY +
  1; // 651

export function decodeObligation(data: Buffer): DecodedObligation | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.obligation) || data.length < OBLIGATION_HEAD + 8) {
    return null;
  }
  let o = OBLIGATION_HEAD;
  const nDeposits = data.readUInt32LE(o);
  o += 4;
  const deposits: ObligationCollateral[] = [];
  for (let i = 0; i < nDeposits; i++) {
    deposits.push({
      reserve: pk(data, o),
      depositedShares: u64(data, o + 32),
      marketValue: u128(data, o + 40),
    });
    o += COLLATERAL_ENTRY;
  }
  const nBorrows = data.readUInt32LE(o);
  o += 4;
  const borrows: ObligationLiquidity[] = [];
  for (let i = 0; i < nBorrows; i++) {
    borrows.push({
      reserve: pk(data, o),
      borrowedPrincipal: u128(data, o + 32),
      marketValue: u128(data, o + 48),
    });
    o += LIQUIDITY_ENTRY;
  }
  return {
    market: pk(data, 8),
    owner: pk(data, 40),
    lastUpdateSlot: u64(data, 72),
    stale: data[80] === 1,
    pricesStressed: data[81] === 1,
    depositedValue: u128(data, 82),
    effectiveCollateralValue: u128(data, 98),
    borrowedValue: u128(data, 114),
    allowedBorrowValue: u128(data, 130),
    unhealthyBorrowValue: u128(data, 146),
    deposits,
    borrows,
  };
}

export type OracleSourceKind = "unitOfAccount" | "nativeExchangeRate" | "marketTwap";
export type OracleHealth =
  "healthy" | "rateWarning" | "borrowFrozen" | "emergency" | "bootstrapping";

const ORACLE_KINDS: OracleSourceKind[] = ["unitOfAccount", "nativeExchangeRate", "marketTwap"];
const ORACLE_HEALTH: OracleHealth[] = [
  "healthy",
  "rateWarning",
  "borrowFrozen",
  "emergency",
  "bootstrapping",
];

export interface DecodedOracle {
  market: PublicKey;
  mint: PublicKey;
  sourceKind: OracleSourceKind;
  /** The program + account `refresh_oracle` must be handed (zero for `unitOfAccount`). */
  sourceProgram: PublicKey;
  sourceAccount: PublicKey;
  maxWithdrawalFeeBps: number;
  /** Last ACCEPTED observation — what every health check prices with. 1e18-scaled COOK per unit. */
  grossRate: bigint;
  effectiveRate: bigint;
  withdrawalFeeBps: number;
  referenceSlot: bigint;
  health: OracleHealth;
  lastMovedBps: bigint;
  lastRefreshSlot: bigint;
}

export function decodeOracle(data: Buffer): DecodedOracle | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.oracleState) || data.length < 302) return null;
  return {
    market: pk(data, 8),
    mint: pk(data, 40),
    sourceKind: ORACLE_KINDS[data[72]!] ?? "unitOfAccount",
    sourceProgram: pk(data, 73),
    sourceAccount: pk(data, 105),
    maxWithdrawalFeeBps: u16(data, 137),
    // 139 rate_floor u128, 155 rate_ceiling u128, 171 expected_deploy_slot, 179 upgrade authority,
    // 211 BreakerConfig (7 bytes), 218 Reference.
    grossRate: u128(data, 218),
    effectiveRate: u128(data, 234),
    withdrawalFeeBps: u16(data, 250),
    referenceSlot: u64(data, 260),
    health: ORACLE_HEALTH[data[276]!] ?? "emergency",
    lastMovedBps: u64(data, 277),
    lastRefreshSlot: u64(data, 285),
  };
}

export interface DecodedSupplyPosition {
  reserve: PublicKey;
  owner: PublicKey;
  /** Gross liquidity ever supplied minus withdrawn — what the per-wallet cap counts. */
  suppliedLiquidity: bigint;
}

export function decodeSupplyPosition(data: Buffer): DecodedSupplyPosition | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.supplyPosition) || data.length < 81) return null;
  return { reserve: pk(data, 8), owner: pk(data, 40), suppliedLiquidity: u64(data, 72) };
}

export interface DecodedRiskConfig {
  reserve: PublicKey;
  /** 0 = unlimited. */
  perWalletBorrowCap: bigint;
  protocolLiquidationShareBps: number;
}

export function decodeRiskConfig(data: Buffer): DecodedRiskConfig | null {
  if (!hasDisc(data, ACCOUNT_DISCRIMINATORS.riskConfig) || data.length < 69) return null;
  return {
    reserve: pk(data, 8),
    perWalletBorrowCap: u64(data, 40),
    protocolLiquidationShareBps: u16(data, 48),
  };
}

// --- Instruction encoding -----------------------------------------------------------------------

function ixData(disc: readonly number[], amount?: bigint): Buffer {
  if (amount === undefined) return Buffer.from(disc);
  const a = Buffer.alloc(8);
  a.writeBigUInt64LE(amount);
  return Buffer.concat([Buffer.from(disc), a]);
}

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const ro = (pubkey: PublicKey): Meta => ({ pubkey, isSigner: false, isWritable: false });
const w = (pubkey: PublicKey): Meta => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey, writable = false): Meta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

function ix(keys: Meta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId: LENDING_PROGRAM_ID, keys, data });
}

/** Permissionless: brings `reserve.borrow_index` to the current slot. Required before most actions. */
export function accrueIx(reserve: PublicKey): TransactionInstruction {
  return ix([w(reserve)], ixData(IX_DISCRIMINATORS.accrue));
}

/**
 * Permissionless. A `nativeExchangeRate` oracle reads `[source_account, ProgramData(source_program)]`
 * from the remaining accounts; a `unitOfAccount` oracle reads nothing.
 */
export function refreshOracleIx(oracle: PublicKey, source?: DecodedOracle): TransactionInstruction {
  const keys = [w(oracle)];
  if (source && source.sourceKind === "nativeExchangeRate") {
    keys.push(ro(source.sourceAccount), ro(programDataAddress(source.sourceProgram)));
  }
  return ix(keys, ixData(IX_DISCRIMINATORS.refreshOracle));
}

/**
 * Permissionless. `pairs` are `[reserve, oracle]` for every deposit (in `obligation.deposits` order),
 * then every borrow (in `obligation.borrows` order) — each reserve accrued and each oracle refreshed
 * earlier in the same transaction.
 */
export function refreshObligationIx(
  obligation: PublicKey,
  pairs: Array<{ reserve: PublicKey; oracle: PublicKey }>,
): TransactionInstruction {
  const keys = [w(obligation)];
  for (const p of pairs) keys.push(ro(p.reserve), ro(p.oracle));
  return ix(keys, ixData(IX_DISCRIMINATORS.refreshObligation));
}

export function initObligationIx(a: {
  market: PublicKey;
  owner: PublicKey;
}): TransactionInstruction {
  return ix(
    [
      ro(a.market),
      w(obligationPda(a.market, a.owner)),
      signer(a.owner, true),
      ro(SystemProgram.programId),
    ],
    ixData(IX_DISCRIMINATORS.initObligation),
  );
}

export interface SupplyAccounts {
  reserve: PublicKey;
  reserveState: Pick<DecodedReserve, "liquidityMint" | "liquidityVault" | "shareMint" | "market">;
  userLiquidity: PublicKey;
  userShare: PublicKey;
  owner: PublicKey;
  liquidityTokenProgram: PublicKey;
}

function supplyLikeKeys(a: SupplyAccounts): Meta[] {
  return [
    ro(globalPda()),
    w(a.reserve),
    ro(a.reserveState.liquidityMint),
    w(a.reserveState.liquidityVault),
    w(a.reserveState.shareMint),
    w(a.userLiquidity),
    w(a.userShare),
    w(supplyPositionPda(a.reserve, a.owner)),
    signer(a.owner, true),
    ro(a.liquidityTokenProgram),
    ro(TOKEN_2022_PROGRAM_ID),
    ro(SystemProgram.programId),
  ];
}

/** `supply(liquidity_amount)`: liquidity in, shares (floor) out. */
export function supplyIx(a: SupplyAccounts, liquidityAmount: bigint): TransactionInstruction {
  return ix(supplyLikeKeys(a), ixData(IX_DISCRIMINATORS.supply, liquidityAmount));
}

/** `withdraw(share_amount)`: shares burned, liquidity (floor) out. Same account shape as `supply`. */
export function withdrawIx(a: SupplyAccounts, shareAmount: bigint): TransactionInstruction {
  return ix(supplyLikeKeys(a), ixData(IX_DISCRIMINATORS.withdraw, shareAmount));
}

export interface CollateralAccounts {
  obligation: PublicKey;
  owner: PublicKey;
  reserve: PublicKey;
  reserveState: Pick<DecodedReserve, "shareMint" | "oracle">;
  userShare: PublicKey;
}

/** `deposit_collateral(share_amount)`: share tokens move into the obligation's vault. */
export function depositCollateralIx(
  a: CollateralAccounts,
  shareAmount: bigint,
): TransactionInstruction {
  return ix(
    [
      ro(globalPda()),
      w(a.obligation),
      signer(a.owner, true),
      ro(a.reserve),
      ro(a.reserveState.shareMint),
      w(obligationShareVaultPda(a.reserve, a.obligation)),
      w(a.userShare),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    ixData(IX_DISCRIMINATORS.depositCollateral, shareAmount),
  );
}

/** `withdraw_collateral(share_amount)`: needs the full refresh prelude in the same tx. */
export function withdrawCollateralIx(
  a: CollateralAccounts,
  shareAmount: bigint,
): TransactionInstruction {
  return ix(
    [
      ro(globalPda()),
      w(a.obligation),
      signer(a.owner),
      ro(a.reserve),
      ro(a.reserveState.oracle),
      ro(a.reserveState.shareMint),
      w(obligationShareVaultPda(a.reserve, a.obligation)),
      w(a.userShare),
      ro(TOKEN_2022_PROGRAM_ID),
    ],
    ixData(IX_DISCRIMINATORS.withdrawCollateral, shareAmount),
  );
}

export interface BorrowAccounts {
  obligation: PublicKey;
  owner: PublicKey;
  reserve: PublicKey;
  reserveState: Pick<DecodedReserve, "liquidityMint" | "liquidityVault" | "oracle">;
  userLiquidity: PublicKey;
  liquidityTokenProgram: PublicKey;
}

/** `borrow(liquidity_amount)`: pays out `amount − origination fee`; the fee is still owed. */
export function borrowIx(a: BorrowAccounts, liquidityAmount: bigint): TransactionInstruction {
  return ix(
    [
      ro(globalPda()),
      w(a.obligation),
      signer(a.owner),
      w(a.reserve),
      ro(a.reserveState.oracle),
      ro(a.reserveState.liquidityMint),
      w(a.reserveState.liquidityVault),
      w(a.userLiquidity),
      ro(a.liquidityTokenProgram),
      ro(riskConfigPda(a.reserve)),
    ],
    ixData(IX_DISCRIMINATORS.borrow, liquidityAmount),
  );
}

export interface RepayAccounts {
  obligation: PublicKey;
  reserve: PublicKey;
  reserveState: Pick<DecodedReserve, "liquidityMint" | "liquidityVault">;
  userLiquidity: PublicKey;
  repayer: PublicKey;
  liquidityTokenProgram: PublicKey;
}

/** `repay(liquidity_amount)`: moves `min(amount, debt now)`; anyone may repay for an obligation. */
export function repayIx(a: RepayAccounts, liquidityAmount: bigint): TransactionInstruction {
  return ix(
    [
      w(a.obligation),
      w(a.reserve),
      ro(a.reserveState.liquidityMint),
      w(a.reserveState.liquidityVault),
      w(a.userLiquidity),
      signer(a.repayer),
      ro(a.liquidityTokenProgram),
    ],
    ixData(IX_DISCRIMINATORS.repay, liquidityAmount),
  );
}

// --- Errors -------------------------------------------------------------------------------------

/**
 * `AeraError` (`errors.rs` in `aeralend/aera-v1`, enum order = code − 6000). Only the variants a
 * user-facing flow can hit are translated; the rest fall through to the raw log line.
 */
export const LENDING_ERRORS: Record<number, string> = {
  6001: "amount must be greater than zero",
  6002: "deposit too small to mint a single share",
  6012: "reserve not accrued this slot (the accrue instruction is missing or landed in an earlier slot)",
  6013: "obligation not refreshed this slot (retry; the refresh must land in the same slot)",
  6014: "the oracle has no accepted price yet",
  6015: "oracle circuit breaker tripped",
  6016: "oracle source account mismatch",
  6026: "oracle not refreshed this slot",
  6027: "borrowing is frozen while the bCOOK price is stressed",
  6028: "the bCOOK oracle is in EMERGENCY — borrowing and collateral withdrawal are frozen",
  6034: "the bCOOK oracle is still bootstrapping — borrowing is not open yet",
  6035: "borrowing is paused by the Aera admin",
  6036: "the Aera protocol is paused",
  6037: "this reserve cannot be borrowed",
  6038: "this reserve cannot be used as collateral",
  6039: "the reserve's supply cap would be exceeded",
  6040: "the reserve's borrow cap would be exceeded",
  6041: "your per-wallet supply cap on this reserve would be exceeded",
  6042: "your per-wallet borrow cap on this reserve would be exceeded",
  6049: "borrow too large for your collateral (loan-to-value exceeded)",
  6050: "withdrawing that much collateral would leave the loan under-collateralised",
  6054: "the reserve does not have that much liquidity available",
  6056: "obligation already tracks the maximum number of reserves",
  6057: "no position on that reserve",
  6058: "refresh_obligation was handed the wrong accounts",
  6059: "market mismatch between accounts",
};

export function lendingSimError(logs: string[]): string | null {
  const blob = logs.join(" ");
  const anchor = /Error Number: (\d+)/.exec(blob);
  if (anchor) {
    const msg = LENDING_ERRORS[Number(anchor[1])];
    if (msg) return msg;
  }
  const insufficient = /insufficient lamports (\d+), need (\d+)/.exec(blob);
  if (insufficient) {
    return `insufficient COOK: the wallet holds ${insufficient[1]} lamports, the transaction needs ${insufficient[2]}`;
  }
  if (/insufficient funds/i.test(blob)) return "insufficient token balance for the transfer";
  return null;
}
