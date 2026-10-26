// Aera — the overcollateralised COOK money market on Cookie Chain (program `Aerafp…`).
//
// Suppliers put COOK (or bCOOK) into a reserve and hold share tokens (aCOOK / abCOOK) that grow with
// interest. Borrowers lock abCOOK shares as collateral in an *obligation* and borrow COOK against
// them. Everything here talks straight to the chain: Aera has no API and no IDL, so instructions are
// hand-encoded (`program.ts`), the program's accounting is mirrored off-chain (`math.ts`) for
// pre-flight checks and estimates, every write is simulated on our RPC, then signed locally.
//
// ⚠️ Transaction shape is load-bearing. Every health-dependent handler refuses a reserve not accrued,
// an oracle not refreshed and an obligation not refreshed IN THE SAME SLOT, so each write below
// prepends the prelude the handler demands (`accrue`, `refresh_oracle`, `refresh_obligation`) in one
// transaction. A split would fail with ReserveStale / OracleStale / ObligationStale.
//
// ⚠️ Collateral is abCOOK SHARES, not bCOOK. `deposit_collateral` therefore supplies bCOOK to its
// reserve and deposits the minted shares in the same transaction, and `withdraw_collateral` undoes
// both — so an agent only ever reasons in bCOOK.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

import { COOK_DECIMALS, COOK_MINT, COOK_SYMBOL, explorerTxUrl } from "../config";
import { confirmSent } from "../confirm";
import { CookieMcpError } from "../errors";
import { bpsToPct, rawToUi, uiToRaw } from "../format";
import { getConnection } from "../rpc";
import { NATIVE_FEE_ALLOWANCE } from "../spendGuard";
import { BCOOK_MINT } from "../stake";
import { fetchMintPrograms, mintProgramOf } from "../transferFee";
import { getSigner, requireSigner } from "../wallet";
import { signWithCosigners } from "../signer";
import { resolveWallet } from "../domains/shared";
import {
  borrowRateBps,
  currentBorrowedAmount,
  evaluateObligation,
  healthFactor,
  liquidityToShares,
  marketValue,
  maxAdditionalBorrow,
  mulDiv,
  projectAccrual,
  sharesToLiquidity,
  supplyHeadroom,
  supplyRateBps,
  totalLiquidity,
  utilizationBps,
  type ObligationHealth,
  type ReserveView,
} from "./math";
import {
  ACCOUNT_DISCRIMINATORS,
  BPS,
  WAD,
  accrueIx,
  borrowIx,
  decodeGlobal,
  decodeMarket,
  decodeObligation,
  decodeOracle,
  decodeReserve,
  decodeRiskConfig,
  decodeSupplyPosition,
  depositCollateralIx,
  globalPda,
  initObligationIx,
  lendingSimError,
  LENDING_PROGRAM_ID,
  marketPda,
  obligationPda,
  refreshObligationIx,
  refreshOracleIx,
  repayIx,
  riskConfigPda,
  supplyIx,
  supplyPositionPda,
  withdrawCollateralIx,
  withdrawIx,
  type DecodedGlobal,
  type DecodedMarket,
  type DecodedObligation,
  type DecodedReserve,
} from "./program";

export * from "./program";
export * from "./math";

export const LENDING_NAME = "Aera";
export const LENDING_SITE_URL = "https://aera.cook";
/**
 * The market this module serves. Aera is one program with possibly several risk-isolated markets;
 * market 0 ("Aera Core": COOK + bCOOK) is the live one — market 1 ("Aera SOL") exists but is empty.
 */
export const LENDING_MARKET_ID = 0n;

/** How many slots ahead a "repay everything" wraps interest for, so the tx cannot come up short. */
const REPAY_ALL_SLOT_MARGIN = 300n;
/** Refuse a borrow / collateral withdrawal that leaves the loan closer than this to liquidation. */
export const DEFAULT_MIN_HEALTH_FACTOR = 1.1;

const COOK = new PublicKey(COOK_MINT);
const KNOWN_SYMBOLS: Record<string, string> = {
  [COOK_MINT]: COOK_SYMBOL,
  [BCOOK_MINT.toBase58()]: "bCOOK",
};

// --- State ----------------------------------------------------------------------------------------

export interface ReserveEntry extends ReserveView {
  pubkey: PublicKey;
  oraclePubkey: PublicKey;
  symbol: string;
  shareSymbol: string;
  /** The token program that owns the liquidity mint (and so the user's ATA for it). */
  liquidityProgram: PublicKey;
  isNative: boolean;
  /** The slot the chain's stored reserve was last accrued at (the entry itself is projected). */
  storedLastUpdateSlot: bigint;
}

export interface LendingState {
  slot: bigint;
  global: DecodedGlobal;
  market: { pubkey: PublicKey } & DecodedMarket;
  /** Every reserve of the market, each projected (`accrue`) to `slot`. */
  reserves: ReserveEntry[];
}

function notReachable(what: string): CookieMcpError {
  return new CookieMcpError(
    `could not read the ${LENDING_NAME} ${what}`,
    `the aera program (${LENDING_PROGRAM_ID.toBase58()}) may not be reachable on this RPC — check ` +
      "COOKIE_RPC_URL",
  );
}

async function fetchReserveAccounts(
  conn: Connection,
  market: PublicKey,
): Promise<Array<{ pubkey: PublicKey; reserve: DecodedReserve }>> {
  const accounts = await conn.getProgramAccounts(LENDING_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(ACCOUNT_DISCRIMINATORS.reserve)) } },
      { memcmp: { offset: 8, bytes: market.toBase58() } },
    ],
  });
  const out: Array<{ pubkey: PublicKey; reserve: DecodedReserve }> = [];
  for (const a of accounts) {
    const reserve = decodeReserve(a.account.data as Buffer);
    if (reserve) out.push({ pubkey: a.pubkey, reserve });
  }
  // Deterministic order: COOK first, then by mint — agents see the same list every call.
  out.sort((x, y) => {
    const xn = x.reserve.liquidityMint.equals(COOK) ? 0 : 1;
    const yn = y.reserve.liquidityMint.equals(COOK) ? 0 : 1;
    return (
      xn - yn ||
      x.reserve.liquidityMint.toBase58().localeCompare(y.reserve.liquidityMint.toBase58())
    );
  });
  return out;
}

export function symbolFor(mint: PublicKey): string {
  return (
    KNOWN_SYMBOLS[mint.toBase58()] ?? `${mint.toBase58().slice(0, 4)}…${mint.toBase58().slice(-4)}`
  );
}

/** One snapshot of the market: global flags, every reserve + oracle, all projected to the current slot. */
export async function loadLendingState(conn: Connection = getConnection()): Promise<LendingState> {
  const marketKey = marketPda(LENDING_MARKET_ID);
  const [slot, heads, reserveAccounts] = await Promise.all([
    conn.getSlot("confirmed"),
    conn.getMultipleAccountsInfo([globalPda(), marketKey], "confirmed"),
    fetchReserveAccounts(conn, marketKey),
  ]);
  const global = heads[0] && decodeGlobal(heads[0].data as Buffer);
  const market = heads[1] && decodeMarket(heads[1].data as Buffer);
  if (!global) throw notReachable("global config");
  if (!market) throw notReachable(`market ${LENDING_MARKET_ID}`);
  if (reserveAccounts.length === 0) throw notReachable("reserves");

  const [oracleInfos, mintPrograms] = await Promise.all([
    conn.getMultipleAccountsInfo(
      reserveAccounts.map((r) => r.reserve.oracle),
      "confirmed",
    ),
    fetchMintPrograms(
      conn,
      reserveAccounts.map((r) => r.reserve.liquidityMint),
    ),
  ]);
  const reserves: ReserveEntry[] = reserveAccounts.map((r, i) => {
    const oracle = oracleInfos[i] && decodeOracle(oracleInfos[i]!.data as Buffer);
    if (!oracle) throw notReachable(`oracle for ${symbolFor(r.reserve.liquidityMint)}`);
    const symbol = symbolFor(r.reserve.liquidityMint);
    return {
      pubkey: r.pubkey,
      reserve: projectAccrual(r.reserve, BigInt(slot)),
      oracle,
      oraclePubkey: r.reserve.oracle,
      symbol,
      shareSymbol: `a${symbol}`,
      liquidityProgram: mintProgramOf(mintPrograms, r.reserve.liquidityMint).program,
      isNative: r.reserve.liquidityMint.equals(NATIVE_MINT),
      storedLastUpdateSlot: r.reserve.lastUpdateSlot,
    };
  });
  return { slot: BigInt(slot), global, market: { pubkey: marketKey, ...market }, reserves };
}

/** Pick a reserve by asset symbol (`COOK`, `bCOOK`, case-insensitive), share symbol, or mint. */
export function findReserve(state: LendingState, asset: string): ReserveEntry {
  const key = asset.trim().toLowerCase();
  const hit = state.reserves.find(
    (r) =>
      r.symbol.toLowerCase() === key ||
      r.shareSymbol.toLowerCase() === key ||
      r.reserve.liquidityMint.toBase58() === asset.trim() ||
      r.reserve.shareMint.toBase58() === asset.trim(),
  );
  if (!hit) {
    throw new CookieMcpError(
      `no ${LENDING_NAME} reserve for "${asset}"`,
      `reserves in this market: ${state.reserves.map((r) => r.symbol).join(", ")} (call get_lending_markets)`,
    );
  }
  return hit;
}

function onlyReserve(
  state: LendingState,
  pick: (r: ReserveEntry) => boolean,
  role: string,
  asset?: string,
): ReserveEntry {
  if (asset) {
    const r = findReserve(state, asset);
    if (!pick(r)) {
      throw new CookieMcpError(
        `${r.symbol} is not ${role} on ${LENDING_NAME}`,
        `${role} reserves: ${
          state.reserves
            .filter(pick)
            .map((x) => x.symbol)
            .join(", ") || "none"
        }`,
      );
    }
    return r;
  }
  const candidates = state.reserves.filter(pick);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new CookieMcpError(`no reserve is ${role} right now`, "check get_lending_markets");
  }
  throw new CookieMcpError(
    `several reserves are ${role}: ${candidates.map((r) => r.symbol).join(", ")}`,
    "pass `asset` to choose one",
  );
}

function lookupFor(state: LendingState): (reserve: PublicKey) => ReserveView {
  return (reserve) => {
    const hit = state.reserves.find((r) => r.pubkey.equals(reserve));
    if (!hit) {
      throw new CookieMcpError(
        `the obligation references a reserve (${reserve.toBase58()}) outside market ${LENDING_MARKET_ID}`,
        "this module serves one market; the position cannot be evaluated here",
      );
    }
    return hit;
  };
}

// --- Token helpers --------------------------------------------------------------------------------

function ata(mint: PublicKey, owner: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, program);
}

function createAtaIx(
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    ata(mint, owner, program),
    owner,
    mint,
    program,
  );
}

/**
 * The native-COOK leg of a reserve whose liquidity mint is wCOOK: a throwaway token account that
 * lives for exactly this transaction. It is funded with `lamports` (for a deposit) or left empty
 * (for a payout), used as `user_liquidity`, then closed back to the wallet — so native COOK goes in
 * and native COOK comes out, and the wallet's own wCOOK ATA (if any) is never touched.
 */
interface NativeLeg {
  account: PublicKey;
  keypair: Keypair;
  open: TransactionInstruction[];
  close: TransactionInstruction;
}

async function nativeLeg(conn: Connection, owner: PublicKey, lamports: bigint): Promise<NativeLeg> {
  const keypair = Keypair.generate();
  const rent = BigInt(
    await conn.getMinimumBalanceForRentExemption(AccountLayout.span, "confirmed"),
  );
  return {
    account: keypair.publicKey,
    keypair,
    open: [
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: keypair.publicKey,
        lamports: Number(rent + lamports),
        space: AccountLayout.span,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(keypair.publicKey, NATIVE_MINT, owner, TOKEN_PROGRAM_ID),
    ],
    close: createCloseAccountInstruction(keypair.publicKey, owner, owner, [], TOKEN_PROGRAM_ID),
  };
}

/** The account the asset moves through for the wallet: a native leg for wCOOK, else the ATA. */
async function liquidityAccount(
  conn: Connection,
  e: ReserveEntry,
  owner: PublicKey,
  fund: bigint,
): Promise<{
  account: PublicKey;
  pre: TransactionInstruction[];
  post: TransactionInstruction[];
  cosigners: Keypair[];
}> {
  if (e.isNative) {
    const leg = await nativeLeg(conn, owner, fund);
    return { account: leg.account, pre: leg.open, post: [leg.close], cosigners: [leg.keypair] };
  }
  return {
    account: ata(e.reserve.liquidityMint, owner, e.liquidityProgram),
    pre: [createAtaIx(e.reserve.liquidityMint, owner, e.liquidityProgram)],
    post: [],
    cosigners: [],
  };
}

/** Token balances of several accounts (0 for an account that does not exist). */
async function tokenBalances(conn: Connection, accounts: PublicKey[]): Promise<bigint[]> {
  if (accounts.length === 0) return [];
  const infos = await conn.getMultipleAccountsInfo(accounts, "confirmed");
  return infos.map((i) => (i ? AccountLayout.decode(i.data as Buffer).amount : 0n));
}

function parseAmount(input: string | number, decimals: number, what: string): bigint {
  let raw: bigint;
  try {
    raw = uiToRaw(input, decimals);
  } catch {
    throw new CookieMcpError(`invalid amount "${input}"`, `pass a positive ${what} amount`);
  }
  if (raw <= 0n) {
    throw new CookieMcpError("amount must be greater than 0", `pass a positive ${what} amount`);
  }
  return raw;
}

function isAll(input: string | number): boolean {
  return typeof input === "string" && input.trim().toLowerCase() === "all";
}

/** 1e18-scaled COOK value → UI string. */
function valueUi(v: bigint): string {
  return rawToUi(v / 10n ** 9n, 9);
}

// --- Send -----------------------------------------------------------------------------------------

async function sendLendingTx(
  conn: Connection,
  tx: Transaction,
  what: string,
  cosigners: Keypair[] = [],
): Promise<string> {
  const signer = requireSigner();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;

  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        `${what} simulation failed: blockhash not found`,
        "Cookie Chain finalization may be stalled — check chain_health; retry shortly",
      );
    }
    const translated = lendingSimError(logs);
    throw new CookieMcpError(
      `${what} failed: ${translated ?? (logs.slice(-2).join(" | ") || JSON.stringify(sim.value.err))}`,
      "nothing was signed or sent",
    );
  }

  await signWithCosigners(signer, tx, cosigners, {
    what,
    blockhash,
    lastValidBlockHeight,
    submit: { via: "cookie-rpc" },
  });
  const signature = await conn.sendRawTransaction(tx.serialize());
  return confirmSent(conn, { signature, blockhash, lastValidBlockHeight }, what);
}

// --- Reads ----------------------------------------------------------------------------------------

export interface LendingReserveView {
  asset: string;
  mint: string;
  shareToken: { symbol: string; mint: string; /** liquidity per share */ exchangeRate: string };
  totalSupplied: string;
  totalBorrowed: string;
  available: string;
  utilization: string;
  supplyApr: string;
  borrowApr: string;
  originationFee: string;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
  /** Collateral terms (meaningful when `collateralEnabled`). */
  loanToValue: string;
  liquidationThreshold: string;
  liquidationBonus: string;
  collateralHaircut: string;
  caps: { supply: string | null; borrow: string | null; perWalletSupply: string | null };
  oracle: {
    kind: string;
    health: string;
    /** COOK per unit of the asset as the program prices it (net of the bCOOK withdrawal fee). */
    cookPerUnit: string;
    lastRefreshSlot: string;
  };
  lastAccrueSlot: string;
  address: string;
}

export interface LendingMarketsResult {
  protocol: string;
  site: string;
  market: { name: string; address: string; program: string };
  paused: boolean;
  borrowPaused: boolean;
  slot: string;
  reserves: LendingReserveView[];
  notes: string[];
}

function capUi(cap: bigint, decimals: number): string | null {
  return cap === 0n ? null : rawToUi(cap, decimals);
}

export function toReserveView(e: ReserveEntry): LendingReserveView {
  const { reserve: r, oracle } = e;
  const d = r.liquidityDecimals;
  const oneShare = 10n ** BigInt(d);
  return {
    asset: e.symbol,
    mint: r.liquidityMint.toBase58(),
    shareToken: {
      symbol: e.shareSymbol,
      mint: r.shareMint.toBase58(),
      exchangeRate: rawToUi(sharesToLiquidity(r, oneShare, "down"), d),
    },
    totalSupplied: rawToUi(totalLiquidity(r), d),
    totalBorrowed: rawToUi(currentBorrowedAmount(r), d),
    available: rawToUi(r.availableLiquidity, d),
    utilization: bpsToPct(Number(utilizationBps(r))),
    supplyApr: bpsToPct(Number(supplyRateBps(r))),
    borrowApr: bpsToPct(Number(borrowRateBps(r))),
    originationFee: bpsToPct(r.config.originationFeeBps),
    borrowEnabled: r.config.borrowEnabled,
    collateralEnabled: r.config.collateralEnabled,
    loanToValue: bpsToPct(r.config.loanToValueBps),
    liquidationThreshold: bpsToPct(r.config.liquidationThresholdBps),
    liquidationBonus: bpsToPct(r.config.liquidationBonusBps),
    collateralHaircut: bpsToPct(r.config.collateralHaircutBps),
    caps: {
      supply: capUi(r.config.supplyCap, d),
      borrow: capUi(r.config.borrowCap, d),
      perWalletSupply: capUi(r.config.perWalletSupplyCap, d),
    },
    oracle: {
      kind: oracle.sourceKind,
      health: oracle.health,
      cookPerUnit: rawToUi(oracle.effectiveRate, 18),
      lastRefreshSlot: oracle.lastRefreshSlot.toString(),
    },
    lastAccrueSlot: e.storedLastUpdateSlot.toString(),
    address: e.pubkey.toBase58(),
  };
}

export async function getLendingMarkets(): Promise<LendingMarketsResult> {
  const state = await loadLendingState();
  const notes = [
    "Supplying mints share tokens (aCOOK / abCOOK) that appreciate with interest; collateral is abCOOK " +
      "shares, which deposit_collateral creates from bCOOK for you.",
    "Rates are projected to the current slot; the chain's stored values lag until someone accrues.",
  ];
  if (state.global.paused) notes.unshift("⚠️ The protocol is PAUSED: only repay works.");
  else if (state.global.borrowPaused) notes.unshift("⚠️ Borrowing is paused by the admin.");
  for (const r of state.reserves) {
    if (r.oracle.health !== "healthy" && r.reserve.config.collateralEnabled) {
      notes.push(
        `⚠️ ${r.symbol} oracle is ${r.oracle.health}: ` +
          (r.oracle.health === "rateWarning"
            ? "borrowing is allowed but marked stressed"
            : "borrow and withdraw_collateral are refused until it recovers"),
      );
    }
  }
  return {
    protocol: LENDING_NAME,
    site: LENDING_SITE_URL,
    market: {
      name: state.market.name,
      address: state.market.pubkey.toBase58(),
      program: LENDING_PROGRAM_ID.toBase58(),
    },
    paused: state.global.paused,
    borrowPaused: state.global.borrowPaused,
    slot: state.slot.toString(),
    reserves: state.reserves.map(toReserveView),
    notes,
  };
}

export interface LendingPositionResult {
  wallet: string;
  name: string | null;
  supplied: Array<{
    asset: string;
    shares: string;
    shareToken: string;
    /** What the wallet's shares redeem for right now. */
    value: string;
    /** Gross supplied, what the per-wallet cap counts. */
    netSupplied: string;
  }>;
  obligation: null | {
    address: string;
    collateral: Array<{ asset: string; shares: string; amount: string; valueCook: string }>;
    borrows: Array<{ asset: string; debt: string; valueCook: string }>;
    collateralValueCook: string;
    borrowedValueCook: string;
    /** How much more COOK-value can be borrowed at the current loan-to-value. */
    borrowHeadroomCook: string;
    healthFactor: number | null;
    liquidatable: boolean;
    pricesStressed: boolean;
    lastRefreshSlot: string;
  };
  maxAdditionalBorrow: Array<{ asset: string; amount: string }>;
  notes: string[];
}

interface WalletView {
  owner: PublicKey;
  shareBalances: bigint[];
  liquidityBalances: bigint[];
  supplied: bigint[];
  obligation: DecodedObligation | null;
  health: ObligationHealth | null;
}

async function loadWallet(
  conn: Connection,
  state: LendingState,
  owner: PublicKey,
): Promise<WalletView> {
  const shareAtas = state.reserves.map((r) =>
    ata(r.reserve.shareMint, owner, TOKEN_2022_PROGRAM_ID),
  );
  const liqAtas = state.reserves.map((r) =>
    ata(r.reserve.liquidityMint, owner, r.liquidityProgram),
  );
  const positions = state.reserves.map((r) => supplyPositionPda(r.pubkey, owner));
  const [shareBalances, liquidityBalances, infos] = await Promise.all([
    tokenBalances(conn, shareAtas),
    tokenBalances(conn, liqAtas),
    conn.getMultipleAccountsInfo(
      [...positions, obligationPda(state.market.pubkey, owner)],
      "confirmed",
    ),
  ]);
  const supplied = positions.map((_, i) => {
    const info = infos[i];
    return (info && decodeSupplyPosition(info.data as Buffer)?.suppliedLiquidity) ?? 0n;
  });
  const obInfo = infos[positions.length];
  const obligation = obInfo ? decodeObligation(obInfo.data as Buffer) : null;
  const health = obligation ? evaluateObligation(obligation, lookupFor(state)) : null;
  return { owner, shareBalances, liquidityBalances, supplied, obligation, health };
}

export async function getLendingPosition(wallet?: string): Promise<LendingPositionResult> {
  const conn = getConnection();
  let owner: PublicKey;
  let name: string | null = null;
  if (wallet) {
    const resolved = await resolveWallet(wallet, "wallet");
    owner = resolved.pubkey;
    name = resolved.name;
  } else {
    const signer = getSigner();
    if (!signer) {
      throw new CookieMcpError(
        "no wallet to inspect",
        "pass `wallet` (address or .cook name), or configure COOKIE_PRIVATE_KEY / COOKIE_WALLET_ADDRESS",
      );
    }
    owner = signer.publicKey;
  }
  const state = await loadLendingState(conn);
  const w = await loadWallet(conn, state, owner);
  const notes: string[] = [];

  const supplied = state.reserves.flatMap((r, i) => {
    const shares = w.shareBalances[i]!;
    if (shares === 0n && w.supplied[i] === 0n) return [];
    const d = r.reserve.liquidityDecimals;
    return [
      {
        asset: r.symbol,
        shares: rawToUi(shares, d),
        shareToken: r.shareSymbol,
        value: rawToUi(sharesToLiquidity(r.reserve, shares, "down"), d),
        netSupplied: rawToUi(w.supplied[i]!, d),
      },
    ];
  });

  let obligation: LendingPositionResult["obligation"] = null;
  if (w.obligation && w.health) {
    const h = w.health;
    const sym = (reserve: PublicKey) => lookupFor(state)(reserve) as ReserveEntry;
    obligation = {
      address: obligationPda(state.market.pubkey, owner).toBase58(),
      collateral: h.deposits.map((d) => {
        const e = sym(d.reserve);
        return {
          asset: e.symbol,
          shares: rawToUi(d.shares, e.reserve.liquidityDecimals),
          amount: rawToUi(d.liquidity, e.reserve.liquidityDecimals),
          valueCook: valueUi(d.value),
        };
      }),
      borrows: h.borrows.map((b) => {
        const e = sym(b.reserve);
        return {
          asset: e.symbol,
          debt: rawToUi(b.debt, e.reserve.liquidityDecimals),
          valueCook: valueUi(b.value),
        };
      }),
      collateralValueCook: valueUi(h.depositedValue),
      borrowedValueCook: valueUi(h.borrowedValue),
      borrowHeadroomCook: valueUi(
        h.allowedBorrowValue > h.borrowedValue ? h.allowedBorrowValue - h.borrowedValue : 0n,
      ),
      healthFactor: healthFactor(h),
      liquidatable: h.liquidatable,
      pricesStressed: h.pricesStressed,
      lastRefreshSlot: w.obligation.lastUpdateSlot.toString(),
    };
    if (h.liquidatable)
      notes.push("⚠️ This position is LIQUIDATABLE — repay or add collateral now.");
    const hf = healthFactor(h);
    if (hf !== null && !h.liquidatable && hf < 1.1) {
      notes.push(
        "⚠️ Health factor is under 1.1 — a small bCOOK rate move or interest could liquidate it.",
      );
    }
  }

  const maxAdditional = state.reserves
    .filter((r) => r.reserve.config.borrowEnabled)
    .map((r) => ({
      asset: r.symbol,
      amount: rawToUi(
        w.health ? maxAdditionalBorrow(w.health, r.reserve, r.oracle) : 0n,
        r.reserve.liquidityDecimals,
      ),
    }));
  if (!w.obligation) {
    notes.push("No obligation yet: deposit_collateral opens one in the same transaction.");
  }
  return {
    wallet: owner.toBase58(),
    name,
    supplied,
    obligation,
    maxAdditionalBorrow: maxAdditional,
    notes,
  };
}

// --- Prelude builder --------------------------------------------------------------------------------

/**
 * The same-slot prelude every health-dependent write needs: refresh every oracle and accrue every
 * reserve the obligation (plus `extra`) touches, then `refresh_obligation` with `[reserve, oracle]`
 * pairs in the program's order (deposits, then borrows). Deduplicated, so a reserve that is both
 * collateral and the action's target is accrued once.
 */
export function preludeIxs(
  state: LendingState,
  obligation: PublicKey,
  ob: Pick<DecodedObligation, "deposits" | "borrows">,
  extra: ReserveEntry[] = [],
): TransactionInstruction[] {
  const lookup = lookupFor(state);
  const touched = new Map<string, ReserveEntry>();
  for (const e of extra) touched.set(e.pubkey.toBase58(), e);
  const pairs = [...ob.deposits, ...ob.borrows].map((p) => {
    const e = lookup(p.reserve) as ReserveEntry;
    touched.set(e.pubkey.toBase58(), e);
    return { reserve: e.pubkey, oracle: e.oraclePubkey };
  });
  const oracles = new Map<string, ReserveEntry>();
  for (const e of touched.values()) oracles.set(e.oraclePubkey.toBase58(), e);
  return [
    ...[...oracles.values()].map((e) => refreshOracleIx(e.oraclePubkey, e.oracle)),
    ...[...touched.values()].map((e) => accrueIx(e.pubkey)),
    refreshObligationIx(obligation, pairs),
  ];
}

// --- Writes -------------------------------------------------------------------------------------------

export interface LendResult {
  signature: string;
  explorerUrl: string;
  supplied: { amount: string; symbol: string };
  received: { estimate: string; symbol: string; mint: string };
  supplyApr: string;
}

/** Supply an asset to its reserve; the wallet receives share tokens. Native COOK is wrapped in-tx. */
export async function lend(args: { asset: string; amount: string | number }): Promise<LendResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const e = findReserve(state, args.asset);
  const r = e.reserve;
  const amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
  if (state.global.paused) {
    throw new CookieMcpError(`${LENDING_NAME} is paused`, "only repay works while paused");
  }

  const w = await loadWallet(conn, state, owner);
  const idx = state.reserves.indexOf(e);
  const { reserveRoom, walletRoom } = supplyHeadroom(r, w.supplied[idx]!);
  if (reserveRoom !== null && amount > reserveRoom) {
    throw new CookieMcpError(
      `the ${e.symbol} reserve's supply cap leaves room for only ${rawToUi(reserveRoom, r.liquidityDecimals)} ${e.symbol}`,
      "lend less, or wait for withdrawals",
    );
  }
  if (walletRoom !== null && amount > walletRoom) {
    throw new CookieMcpError(
      `your per-wallet supply cap on ${e.symbol} leaves room for only ${rawToUi(walletRoom, r.liquidityDecimals)} ${e.symbol}`,
      `the cap is ${rawToUi(r.config.perWalletSupplyCap, r.liquidityDecimals)} ${e.symbol} per wallet`,
    );
  }
  const shares = liquidityToShares(r, amount, "down");
  if (shares === 0n)
    throw new CookieMcpError("amount too small to mint a single share", "supply more");

  if (e.isNative) {
    const lamports = BigInt(await conn.getBalance(owner, "confirmed"));
    if (lamports < amount + NATIVE_FEE_ALLOWANCE) {
      throw new CookieMcpError(
        `insufficient COOK: wallet holds ${rawToUi(lamports, COOK_DECIMALS)}, needs ${rawToUi(amount + NATIVE_FEE_ALLOWANCE, COOK_DECIMALS)} incl. fees`,
        "lend less",
      );
    }
  } else if (w.liquidityBalances[idx]! < amount) {
    throw new CookieMcpError(
      `insufficient ${e.symbol}: wallet holds ${rawToUi(w.liquidityBalances[idx]!, r.liquidityDecimals)}`,
      "lend less",
    );
  }

  const leg = await liquidityAccount(conn, e, owner, amount);
  const tx = new Transaction();
  tx.add(createAtaIx(r.shareMint, owner, TOKEN_2022_PROGRAM_ID), ...leg.pre);
  tx.add(
    accrueIx(e.pubkey),
    supplyIx(
      {
        reserve: e.pubkey,
        reserveState: r,
        userLiquidity: leg.account,
        userShare: ata(r.shareMint, owner, TOKEN_2022_PROGRAM_ID),
        owner,
        liquidityTokenProgram: e.liquidityProgram,
      },
      amount,
    ),
    ...leg.post,
  );

  const signature = await sendLendingTx(conn, tx, `lend ${e.symbol}`, leg.cosigners);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    supplied: { amount: rawToUi(amount, r.liquidityDecimals), symbol: e.symbol },
    received: {
      estimate: rawToUi(shares, r.liquidityDecimals),
      symbol: e.shareSymbol,
      mint: r.shareMint.toBase58(),
    },
    supplyApr: bpsToPct(Number(supplyRateBps(r))),
  };
}

export interface WithdrawLendResult {
  signature: string;
  explorerUrl: string;
  burned: { shares: string; symbol: string };
  received: { estimate: string; symbol: string };
}

/** Redeem share tokens held in the wallet for the underlying asset (`amount` in asset units, or "all"). */
export async function withdrawLend(args: {
  asset: string;
  amount: string | number;
}): Promise<WithdrawLendResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const e = findReserve(state, args.asset);
  const r = e.reserve;
  if (state.global.paused) {
    throw new CookieMcpError(`${LENDING_NAME} is paused`, "only repay works while paused");
  }
  const w = await loadWallet(conn, state, owner);
  const idx = state.reserves.indexOf(e);
  const held = w.shareBalances[idx]!;
  if (held === 0n) {
    const inObligation = w.health?.deposits.find((d) => d.reserve.equals(e.pubkey));
    throw new CookieMcpError(
      `the wallet holds no ${e.shareSymbol}`,
      inObligation
        ? `your ${e.symbol} is locked as collateral (${rawToUi(inObligation.shares, r.liquidityDecimals)} ${e.shareSymbol}) — use withdraw_collateral`
        : `nothing was lent to the ${e.symbol} reserve from this wallet`,
    );
  }
  let shares: bigint;
  if (isAll(args.amount)) {
    shares = held;
  } else {
    const amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
    // Round the share burn UP so the floor-rounded payout is at least what was asked for.
    shares = liquidityToShares(r, amount, "up");
    if (shares > held) {
      throw new CookieMcpError(
        `that needs ${rawToUi(shares, r.liquidityDecimals)} ${e.shareSymbol} but the wallet holds ${rawToUi(held, r.liquidityDecimals)}`,
        `the wallet's shares redeem for ${rawToUi(sharesToLiquidity(r, held, "down"), r.liquidityDecimals)} ${e.symbol}; pass "all" to withdraw everything`,
      );
    }
  }
  const liquidity = sharesToLiquidity(r, shares, "down");
  if (liquidity > r.availableLiquidity) {
    throw new CookieMcpError(
      `the ${e.symbol} reserve only has ${rawToUi(r.availableLiquidity, r.liquidityDecimals)} ${e.symbol} available (the rest is lent out)`,
      "withdraw less now and the rest as borrowers repay",
    );
  }

  const leg = await liquidityAccount(conn, e, owner, 0n);
  const tx = new Transaction();
  tx.add(
    ...leg.pre,
    accrueIx(e.pubkey),
    withdrawIx(
      {
        reserve: e.pubkey,
        reserveState: r,
        userLiquidity: leg.account,
        userShare: ata(r.shareMint, owner, TOKEN_2022_PROGRAM_ID),
        owner,
        liquidityTokenProgram: e.liquidityProgram,
      },
      shares,
    ),
    ...leg.post,
  );

  const signature = await sendLendingTx(conn, tx, `withdraw ${e.symbol}`, leg.cosigners);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    burned: { shares: rawToUi(shares, r.liquidityDecimals), symbol: e.shareSymbol },
    received: { estimate: rawToUi(liquidity, r.liquidityDecimals), symbol: e.symbol },
  };
}

export interface CollateralResult {
  signature: string;
  explorerUrl: string;
  asset: string;
  amount: string;
  shares: string;
  obligation: string;
  healthFactor: number | null;
}

function requireOracleFor(e: ReserveEntry, action: "borrow" | "withdraw collateral") {
  if (e.oracle.health === "healthy" || e.oracle.health === "rateWarning") return;
  throw new CookieMcpError(
    `${action} is frozen: the ${e.symbol} oracle is ${e.oracle.health}`,
    e.oracle.health === "bootstrapping"
      ? "the oracle needs another stake-pool epoch to confirm its first rate"
      : "supply, deposit and repay still work; wait for the oracle to recover",
  );
}

/**
 * Lock bCOOK as collateral: supplies it to its reserve and deposits the minted shares into the
 * wallet's obligation in one transaction (creating the obligation on first use). With
 * `useHeldShares`, deposits share tokens the wallet already holds instead of supplying new bCOOK.
 */
export async function depositCollateral(args: {
  amount: string | number;
  asset?: string;
  useHeldShares?: boolean;
}): Promise<CollateralResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const e = onlyReserve(
    state,
    (x) => x.reserve.config.collateralEnabled,
    "collateral-enabled",
    args.asset,
  );
  const r = e.reserve;
  const amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
  if (state.global.paused) {
    throw new CookieMcpError(`${LENDING_NAME} is paused`, "only repay works while paused");
  }
  const w = await loadWallet(conn, state, owner);
  const idx = state.reserves.indexOf(e);
  const obligation = obligationPda(state.market.pubkey, owner);
  const tx = new Transaction();
  tx.add(createAtaIx(r.shareMint, owner, TOKEN_2022_PROGRAM_ID));
  if (!w.obligation) tx.add(initObligationIx({ market: state.market.pubkey, owner }));

  let shares: bigint;
  if (args.useHeldShares) {
    shares = liquidityToShares(r, amount, "down");
    if (shares > w.shareBalances[idx]!) {
      throw new CookieMcpError(
        `the wallet holds ${rawToUi(w.shareBalances[idx]!, r.liquidityDecimals)} ${e.shareSymbol}, not enough for ${rawToUi(amount, r.liquidityDecimals)} ${e.symbol}`,
        "omit useHeldShares to supply bCOOK from the wallet instead",
      );
    }
  } else {
    if (w.liquidityBalances[idx]! < amount) {
      throw new CookieMcpError(
        `insufficient ${e.symbol}: wallet holds ${rawToUi(w.liquidityBalances[idx]!, r.liquidityDecimals)}`,
        e.symbol === "bCOOK" ? "stake COOK for bCOOK first (`stake`)" : "deposit less",
      );
    }
    const { reserveRoom, walletRoom } = supplyHeadroom(r, w.supplied[idx]!);
    const room = [reserveRoom, walletRoom].filter((x): x is bigint => x !== null);
    if (room.some((x) => amount > x)) {
      throw new CookieMcpError(
        `the ${e.symbol} reserve's caps leave room for only ${rawToUi(
          room.reduce((a, b) => (a < b ? a : b)),
          r.liquidityDecimals,
        )} ${e.symbol}`,
        "deposit less",
      );
    }
    shares = liquidityToShares(r, amount, "down");
    if (shares === 0n)
      throw new CookieMcpError("amount too small to mint a single share", "deposit more");
    tx.add(
      accrueIx(e.pubkey),
      supplyIx(
        {
          reserve: e.pubkey,
          reserveState: r,
          userLiquidity: ata(r.liquidityMint, owner, e.liquidityProgram),
          userShare: ata(r.shareMint, owner, TOKEN_2022_PROGRAM_ID),
          owner,
          liquidityTokenProgram: e.liquidityProgram,
        },
        amount,
      ),
    );
  }
  tx.add(
    depositCollateralIx(
      {
        obligation,
        owner,
        reserve: e.pubkey,
        reserveState: r,
        userShare: ata(r.shareMint, owner, TOKEN_2022_PROGRAM_ID),
      },
      shares,
    ),
  );

  const signature = await sendLendingTx(conn, tx, `deposit ${e.symbol} collateral`);
  const after = evaluateObligation(
    withCollateral(w.obligation, e.pubkey, shares),
    lookupFor(state),
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    asset: e.symbol,
    amount: rawToUi(amount, r.liquidityDecimals),
    shares: rawToUi(shares, r.liquidityDecimals),
    obligation: obligation.toBase58(),
    healthFactor: healthFactor(after),
  };
}

/** The obligation's deposits with `delta` shares added to (or removed from) `reserve`. */
export function withCollateral(
  ob: DecodedObligation | null,
  reserve: PublicKey,
  delta: bigint,
): Pick<DecodedObligation, "deposits" | "borrows"> {
  const deposits = (ob?.deposits ?? []).map((d) => ({ ...d }));
  const hit = deposits.find((d) => d.reserve.equals(reserve));
  if (hit) hit.depositedShares += delta;
  else deposits.push({ reserve, depositedShares: delta, marketValue: 0n });
  return { deposits: deposits.filter((d) => d.depositedShares > 0n), borrows: ob?.borrows ?? [] };
}

function requireHealth(after: ObligationHealth, minHealthFactor: number, action: string): void {
  const hf = healthFactor(after);
  if (hf === null) return;
  if (hf < minHealthFactor) {
    throw new CookieMcpError(
      `refused: after this ${action} the health factor would be ${hf.toFixed(3)}, under the ${minHealthFactor} floor`,
      "pass a lower `minHealthFactor` (1.0 = the liquidation line) to accept more risk, or " +
        `${action === "borrow" ? "borrow less" : "withdraw less"}`,
    );
  }
}

/**
 * Take collateral back out: withdraws abCOOK shares from the obligation and, unless `keepShares`,
 * redeems them for bCOOK in the same transaction. Refuses before signing when the loan would be left
 * over the loan-to-value limit or under `minHealthFactor`.
 */
export async function withdrawCollateral(args: {
  amount: string | number;
  asset?: string;
  keepShares?: boolean;
  minHealthFactor?: number;
}): Promise<CollateralResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const w = await loadWallet(conn, state, owner);
  if (!w.obligation || !w.health) {
    throw new CookieMcpError("this wallet has no obligation", "nothing is deposited as collateral");
  }
  const e = onlyReserve(
    state,
    (x) => x.reserve.config.collateralEnabled,
    "collateral-enabled",
    args.asset,
  );
  const r = e.reserve;
  if (state.global.paused) {
    throw new CookieMcpError(`${LENDING_NAME} is paused`, "only repay works while paused");
  }
  requireOracleFor(e, "withdraw collateral");
  const deposited = w.health.deposits.find((d) => d.reserve.equals(e.pubkey));
  if (!deposited || deposited.shares === 0n) {
    throw new CookieMcpError(
      `no ${e.symbol} collateral in this obligation`,
      "check get_lending_position",
    );
  }
  let shares: bigint;
  if (isAll(args.amount)) {
    shares = deposited.shares;
  } else {
    const amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
    shares = liquidityToShares(r, amount, "up");
    if (shares > deposited.shares) shares = deposited.shares;
  }

  // Mirror the handler: the allowance removed is computed with ceilings, against the stale allowed value.
  const removedLiquidity = sharesToLiquidity(r, shares, "up");
  const removedFace = marketValue(
    removedLiquidity,
    r.liquidityDecimals,
    e.oracle.effectiveRate,
    "up",
  );
  const removedEffective = mulDiv(
    removedFace,
    BPS - BigInt(r.config.collateralHaircutBps),
    BPS,
    "up",
  );
  const removedAllowed = mulDiv(removedEffective, BigInt(r.config.loanToValueBps), BPS, "up");
  const h = w.health;
  const newAllowed =
    h.allowedBorrowValue > removedAllowed ? h.allowedBorrowValue - removedAllowed : 0n;
  if (h.borrowedValue > newAllowed) {
    throw new CookieMcpError(
      `withdrawing ${rawToUi(removedLiquidity, r.liquidityDecimals)} ${e.symbol} would leave the loan over its loan-to-value limit`,
      `borrow headroom is ${valueUi(h.allowedBorrowValue > h.borrowedValue ? h.allowedBorrowValue - h.borrowedValue : 0n)} COOK of value; withdraw less, or repay first`,
    );
  }
  const after = evaluateObligation(
    withCollateral(w.obligation, e.pubkey, -shares),
    lookupFor(state),
  );
  requireHealth(after, args.minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR, "withdrawal");
  const liquidity = sharesToLiquidity(r, shares, "down");
  if (!args.keepShares && liquidity > r.availableLiquidity) {
    throw new CookieMcpError(
      `the ${e.symbol} reserve only has ${rawToUi(r.availableLiquidity, r.liquidityDecimals)} ${e.symbol} available to redeem`,
      "pass keepShares: true to take the share tokens out without redeeming them",
    );
  }

  const obligation = obligationPda(state.market.pubkey, owner);
  const tx = new Transaction();
  tx.add(...preludeIxs(state, obligation, w.obligation, [e]));
  tx.add(createAtaIx(r.shareMint, owner, TOKEN_2022_PROGRAM_ID));
  const userShare = ata(r.shareMint, owner, TOKEN_2022_PROGRAM_ID);
  tx.add(
    withdrawCollateralIx(
      { obligation, owner, reserve: e.pubkey, reserveState: r, userShare },
      shares,
    ),
  );
  const cosigners: Keypair[] = [];
  if (!args.keepShares) {
    const leg = await liquidityAccount(conn, e, owner, 0n);
    cosigners.push(...leg.cosigners);
    tx.add(
      ...leg.pre,
      withdrawIx(
        {
          reserve: e.pubkey,
          reserveState: r,
          userLiquidity: leg.account,
          userShare,
          owner,
          liquidityTokenProgram: e.liquidityProgram,
        },
        shares,
      ),
      ...leg.post,
    );
  }

  const signature = await sendLendingTx(conn, tx, `withdraw ${e.symbol} collateral`, cosigners);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    asset: e.symbol,
    amount: rawToUi(args.keepShares ? removedLiquidity : liquidity, r.liquidityDecimals),
    shares: rawToUi(shares, r.liquidityDecimals),
    obligation: obligation.toBase58(),
    healthFactor: healthFactor(after),
  };
}

export interface BorrowResult {
  signature: string;
  explorerUrl: string;
  borrowed: { amount: string; symbol: string };
  originationFee: string;
  received: string;
  borrowApr: string;
  healthFactor: number | null;
  obligation: string;
}

/** Borrow against the obligation's collateral. `amount` is the debt taken on; the fee is deducted from the payout. */
export async function borrow(args: {
  amount: string | number;
  asset?: string;
  minHealthFactor?: number;
}): Promise<BorrowResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const e = onlyReserve(state, (x) => x.reserve.config.borrowEnabled, "borrowable", args.asset);
  const r = e.reserve;
  const amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
  if (state.global.paused || state.global.borrowPaused) {
    throw new CookieMcpError(`borrowing on ${LENDING_NAME} is paused`, "try later");
  }
  requireOracleFor(e, "borrow");
  const w = await loadWallet(conn, state, owner);
  if (!w.obligation || !w.health || w.health.deposits.length === 0) {
    throw new CookieMcpError(
      "no collateral deposited",
      "call deposit_collateral (bCOOK) first; borrowing is against abCOOK collateral only",
    );
  }
  for (const d of w.health.deposits) {
    requireOracleFor(lookupFor(state)(d.reserve) as ReserveEntry, "borrow");
  }
  const h = w.health;
  if (h.pricesStressed) {
    throw new CookieMcpError(
      "borrowing is frozen while a collateral price is stressed (oracle rateWarning)",
      "wait for the bCOOK oracle to settle",
    );
  }
  const borrowValue = marketValue(amount, r.liquidityDecimals, e.oracle.effectiveRate, "up");
  if (h.borrowedValue + borrowValue > h.allowedBorrowValue) {
    throw new CookieMcpError(
      `borrow too large: ${rawToUi(amount, r.liquidityDecimals)} ${e.symbol} exceeds the loan-to-value limit`,
      `at most ${rawToUi(maxAdditionalBorrow(h, r, e.oracle), r.liquidityDecimals)} ${e.symbol} more can be borrowed; deposit more collateral to raise it`,
    );
  }
  if (amount > r.availableLiquidity) {
    throw new CookieMcpError(
      `the ${e.symbol} reserve only has ${rawToUi(r.availableLiquidity, r.liquidityDecimals)} ${e.symbol} available`,
      "borrow less",
    );
  }
  if (r.config.borrowCap > 0n && currentBorrowedAmount(r) + amount > r.config.borrowCap) {
    throw new CookieMcpError(
      `the ${e.symbol} reserve's borrow cap would be exceeded`,
      "borrow less",
    );
  }
  const riskInfo = await conn.getAccountInfo(riskConfigPda(e.pubkey), "confirmed");
  const risk = riskInfo && decodeRiskConfig(riskInfo.data as Buffer);
  if (risk && risk.perWalletBorrowCap > 0n) {
    const owed = h.borrows.find((b) => b.reserve.equals(e.pubkey))?.debt ?? 0n;
    if (owed + amount > risk.perWalletBorrowCap) {
      throw new CookieMcpError(
        `your per-wallet ${e.symbol} borrow cap (${rawToUi(risk.perWalletBorrowCap, r.liquidityDecimals)}) would be exceeded`,
        `you owe ${rawToUi(owed, r.liquidityDecimals)} already`,
      );
    }
  }
  // Health after: the new principal at today's index, valued with ceilings like refresh_obligation.
  const scaledAdded = mulDiv(amount, WAD, r.borrowIndex, "up");
  const borrowsAfter = w.obligation.borrows.map((b) => ({ ...b }));
  const hit = borrowsAfter.find((b) => b.reserve.equals(e.pubkey));
  if (hit) hit.borrowedPrincipal += scaledAdded;
  else borrowsAfter.push({ reserve: e.pubkey, borrowedPrincipal: scaledAdded, marketValue: 0n });
  const after = evaluateObligation(
    { deposits: w.obligation.deposits, borrows: borrowsAfter },
    lookupFor(state),
  );
  requireHealth(after, args.minHealthFactor ?? DEFAULT_MIN_HEALTH_FACTOR, "borrow");

  const fee = mulDiv(amount, BigInt(r.config.originationFeeBps), BPS, "down");
  const paidOut = amount - fee;
  if (paidOut <= 0n) throw new CookieMcpError("amount too small", "borrow more");

  const obligation = obligationPda(state.market.pubkey, owner);
  const tx = new Transaction();
  tx.add(...preludeIxs(state, obligation, w.obligation, [e]));
  const leg = await liquidityAccount(conn, e, owner, 0n);
  tx.add(
    ...leg.pre,
    borrowIx(
      {
        obligation,
        owner,
        reserve: e.pubkey,
        reserveState: r,
        userLiquidity: leg.account,
        liquidityTokenProgram: e.liquidityProgram,
      },
      amount,
    ),
    ...leg.post,
  );

  const signature = await sendLendingTx(conn, tx, `borrow ${e.symbol}`, leg.cosigners);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    borrowed: { amount: rawToUi(amount, r.liquidityDecimals), symbol: e.symbol },
    originationFee: rawToUi(fee, r.liquidityDecimals),
    received: rawToUi(paidOut, r.liquidityDecimals),
    borrowApr: bpsToPct(Number(borrowRateBps(r))),
    healthFactor: healthFactor(after),
    obligation: obligation.toBase58(),
  };
}

export interface RepayResult {
  signature: string;
  explorerUrl: string;
  repaid: { amount: string; symbol: string };
  remainingDebt: string;
  obligation: string;
}

/**
 * Repay debt (`amount` in asset units, or "all"). The program moves `min(amount, debt now)`, so
 * "all" wraps a little extra for interest accrued between now and landing; the excess is unwrapped
 * back in the same transaction.
 */
export async function repay(args: {
  amount: string | number;
  asset?: string;
}): Promise<RepayResult> {
  const signer = requireSigner();
  const owner = signer.publicKey;
  const conn = getConnection();
  const state = await loadLendingState(conn);
  const w = await loadWallet(conn, state, owner);
  if (!w.obligation || !w.health || w.health.borrows.length === 0) {
    throw new CookieMcpError("this wallet has no debt", "nothing to repay");
  }
  const e = onlyReserve(
    state,
    (x) => w.health!.borrows.some((b) => b.reserve.equals(x.pubkey)),
    "borrowed from",
    args.asset,
  );
  const r = e.reserve;
  const debtNow = w.health.borrows.find((b) => b.reserve.equals(e.pubkey))!.debt;
  let amount: bigint;
  if (isAll(args.amount)) {
    const ahead = projectAccrual(r, state.slot + REPAY_ALL_SLOT_MARGIN);
    const principal = w.obligation.borrows.find((b) =>
      b.reserve.equals(e.pubkey),
    )!.borrowedPrincipal;
    amount = mulDiv(principal, ahead.borrowIndex, WAD, "up") + 1n;
  } else {
    amount = parseAmount(args.amount, r.liquidityDecimals, e.symbol);
  }
  const idx = state.reserves.indexOf(e);
  if (e.isNative) {
    const lamports = BigInt(await conn.getBalance(owner, "confirmed"));
    if (lamports < amount + NATIVE_FEE_ALLOWANCE) {
      throw new CookieMcpError(
        `insufficient COOK: wallet holds ${rawToUi(lamports, COOK_DECIMALS)}, needs ${rawToUi(amount + NATIVE_FEE_ALLOWANCE, COOK_DECIMALS)} incl. fees`,
        `repay less (debt is ${rawToUi(debtNow, r.liquidityDecimals)} ${e.symbol})`,
      );
    }
  } else if (w.liquidityBalances[idx]! < amount) {
    throw new CookieMcpError(
      `insufficient ${e.symbol}: wallet holds ${rawToUi(w.liquidityBalances[idx]!, r.liquidityDecimals)}`,
      "repay less",
    );
  }

  const obligation = obligationPda(state.market.pubkey, owner);
  const leg = await liquidityAccount(conn, e, owner, amount);
  const tx = new Transaction();
  tx.add(
    ...leg.pre,
    accrueIx(e.pubkey),
    repayIx(
      {
        obligation,
        reserve: e.pubkey,
        reserveState: r,
        userLiquidity: leg.account,
        repayer: owner,
        liquidityTokenProgram: e.liquidityProgram,
      },
      amount,
    ),
    ...leg.post,
  );

  const signature = await sendLendingTx(conn, tx, `repay ${e.symbol}`, leg.cosigners);
  const repaid = amount < debtNow ? amount : debtNow;
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    repaid: { amount: rawToUi(repaid, r.liquidityDecimals), symbol: e.symbol },
    remainingDebt: rawToUi(debtNow > repaid ? debtNow - repaid : 0n, r.liquidityDecimals),
    obligation: obligation.toBase58(),
  };
}
