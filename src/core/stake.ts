// Liquid staking on Cookie Chain's bCOOK (bakedCOOK) — the canonical SPL Stake Pool program.
// stake COOK → mint bCOOK (DepositSol), unstake bCOOK → COOK (WithdrawSol, instant from the reserve).
//
// ⚠️ The high-level @solana/spl-stake-pool helpers auto-select the *mainnet* stake-pool program id from
// the RPC and build invalid txs on the fork. So we hand-build both instructions against the Cookie
// program id (per bakeyourstake.xyz's integration guide) and hand-decode the pool state — no SDK, no
// mainnet-derivation hazard. Non-custodial; every op simulates before sending.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  StakeProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  type Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createApproveInstruction,
} from "@solana/spl-token";

import { COOK_DECIMALS, COOK_SYMBOL, explorerTxUrl, explorerAddressUrl } from "./config";
import { CookieMcpError } from "./errors";
import { getConnection } from "./rpc";
import { requireWallet, assertWithinSpendCap } from "./wallet";
import { rawToUi, uiToRaw } from "./format";

// --- Cookie Chain bCOOK stake pool (canonical SPL Stake Pool program) ---------------------------
export const STAKE_POOL_PROGRAM = new PublicKey("GZgs5uREPp6BvDt8eysmhavQPAHBAtjePgV4zfhgd9pH");
export const STAKE_POOL = new PublicKey("GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4");
export const BCOOK_MINT = new PublicKey("EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz");
const RESERVE_STAKE = new PublicKey("GAw1vRQ8R3ohDsSgGZV58dc32W7jYhHtc8DzuiVdvm8F");
const MANAGER_FEE = new PublicKey("6ay8hjir4VZJ38x9sfL44Su8bvDEXmc5FrNyErHyv7G8");

export const BCOOK_DECIMALS = 9;
export const DEPOSIT_FEE_BPS = 50; // 0.5% on deposit
export const WITHDRAW_FEE_BPS = 200; // 2% on withdrawal
const RATE_HISTORY_URL = "https://bakeyourstake.xyz/rate-history.json";
const HTTP_TIMEOUT_MS = 8_000;

// SPL StakePool instruction tags.
export const IX_DEPOSIT_SOL = 14;
export const IX_WITHDRAW_SOL = 16;

export const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync(
  [STAKE_POOL.toBuffer(), Buffer.from("withdraw")],
  STAKE_POOL_PROGRAM,
)[0];

// SPL StakePool account layout offsets (accountType u8, then 9 pubkeys + a bump byte, then two u64s).
const OFF_TOTAL_LAMPORTS = 258;
const OFF_POOL_TOKEN_SUPPLY = 266;

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** `tag(u8) + amount(u64 LE)` — the SPL StakePool ix data layout for DepositSol/WithdrawSol. */
export function encodeStakeIxData(tag: number, amount: bigint): Buffer {
  return Buffer.concat([Buffer.from([tag]), u64LE(amount)]);
}

interface StakePoolState {
  totalLamports: bigint;
  poolTokenSupply: bigint;
  /** COOK per bCOOK; only ever rises. */
  rate: number;
}

/** COOK per bCOOK from the pool's two u64s (1 when the pool is empty). */
export function poolRate(totalLamports: bigint, poolTokenSupply: bigint): number {
  return poolTokenSupply === 0n ? 1 : Number(totalLamports) / Number(poolTokenSupply);
}

/** Decode a raw SPL StakePool account into its exchange-rate state (validates the account tag/size). */
export function decodeStakePool(data: Buffer): StakePoolState {
  if (data.length < OFF_POOL_TOKEN_SUPPLY + 8 || data[0] !== 1) {
    throw new CookieMcpError(
      "could not read the bCOOK stake pool",
      "the stake pool account was not found or has an unexpected layout; retry",
    );
  }
  const totalLamports = data.readBigUInt64LE(OFF_TOTAL_LAMPORTS);
  const poolTokenSupply = data.readBigUInt64LE(OFF_POOL_TOKEN_SUPPLY);
  return { totalLamports, poolTokenSupply, rate: poolRate(totalLamports, poolTokenSupply) };
}

/** bCOOK received for staking `cookUi` COOK, after the deposit fee. */
export function estimateBcookOut(cookUi: number, rate: number): number {
  return (cookUi * (1 - DEPOSIT_FEE_BPS / 10_000)) / rate;
}

/** COOK received for unstaking `bcookUi` bCOOK, after the withdrawal fee. */
export function estimateCookOut(bcookUi: number, rate: number): number {
  return bcookUi * rate * (1 - WITHDRAW_FEE_BPS / 10_000);
}

async function fetchStakePool(conn: Connection): Promise<StakePoolState> {
  const acc = await conn.getAccountInfo(STAKE_POOL);
  if (!acc) {
    throw new CookieMcpError(
      "could not read the bCOOK stake pool",
      "the stake pool account was not found or has an unexpected layout; retry",
    );
  }
  return decodeStakePool(acc.data);
}

// APY from the public hourly rate-history (JSONL) — best-effort; null if unreachable.
async function estimateApy(): Promise<number | null> {
  try {
    const res = await fetch(RATE_HISTORY_URL, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const lines = (await res.text())
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return null;
    const parse = (l: string) => JSON.parse(l) as { t: number; total: number; supply: number };
    const first = parse(lines[0]!);
    const last = parse(lines[lines.length - 1]!);
    const rateOld = first.total / first.supply;
    const rateNew = last.total / last.supply;
    const elapsed = last.t - first.t;
    if (!(elapsed > 0) && !(rateOld > 0)) return null;
    if (elapsed <= 0 || rateOld <= 0) return null;
    const apy = (rateNew / rateOld - 1) * ((365 * 24 * 3600) / elapsed) * 100;
    return Number.isFinite(apy) ? apy : null;
  } catch {
    return null;
  }
}

export interface StakeInfo {
  bcookMint: string;
  stakePool: string;
  program: string;
  rate: number; // COOK per bCOOK
  bcookPerCook: number; // inverse, before fees
  tvlCook: string;
  bcookSupply: string;
  fees: { depositPct: number; withdrawPct: number };
  apyPct: number | null;
  links: { pool: string };
}

export async function getStakeInfo(): Promise<StakeInfo> {
  const conn = getConnection();
  const [pool, apy] = await Promise.all([fetchStakePool(conn), estimateApy()]);
  return {
    bcookMint: BCOOK_MINT.toBase58(),
    stakePool: STAKE_POOL.toBase58(),
    program: STAKE_POOL_PROGRAM.toBase58(),
    rate: pool.rate,
    bcookPerCook: pool.rate > 0 ? 1 / pool.rate : 0,
    tvlCook: rawToUi(pool.totalLamports, COOK_DECIMALS),
    bcookSupply: rawToUi(pool.poolTokenSupply, BCOOK_DECIMALS),
    fees: { depositPct: DEPOSIT_FEE_BPS / 100, withdrawPct: WITHDRAW_FEE_BPS / 100 },
    apyPct: apy,
    links: { pool: explorerAddressUrl(STAKE_POOL.toBase58()) },
  };
}

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  what: string,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        `${what} simulation failed: blockhash not found`,
        "Cookie Chain finalization may be stalled — check chain_health; retry",
      );
    }
    throw new CookieMcpError(
      `${what} simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "check your balance and the amount; the transaction was not sent",
    );
  }
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

export interface StakeResult {
  signature: string;
  staked: { amount: string; symbol: string };
  received: { estimate: string; symbol: string };
  rate: number;
  explorerUrl: string;
}

// DepositSol (instruction 14): funds an ephemeral system account with the deposit, which the pool
// program debits — receives `amount × (1 − depositFee) / rate` bCOOK.
export async function stake(args: { amount: string | number }): Promise<StakeResult> {
  const { keypair } = requireWallet();
  const owner = keypair.publicKey;
  const conn = getConnection();

  const amountUi = Number(args.amount);
  assertWithinSpendCap(amountUi, 1); // input is COOK, valued 1:1
  let lamports: bigint;
  try {
    lamports = uiToRaw(args.amount, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(`invalid amount "${args.amount}"`, "pass a positive COOK amount");
  }
  if (lamports <= 0n)
    throw new CookieMcpError("amount must be greater than 0", "pass a positive COOK amount");

  const pool = await fetchStakePool(conn);
  const destAta = getAssociatedTokenAddressSync(BCOOK_MINT, owner, true, TOKEN_PROGRAM_ID);
  const ephemeral = Keypair.generate();

  const depositIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM,
    data: encodeStakeIxData(IX_DEPOSIT_SOL, lamports),
    keys: [
      { pubkey: STAKE_POOL, isSigner: false, isWritable: true },
      { pubkey: WITHDRAW_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true },
      { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true }, // funding account
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: MANAGER_FEE, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true }, // referral = self
      { pubkey: BCOOK_MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ephemeral.publicKey, lamports }),
    createAssociatedTokenAccountIdempotentInstruction(owner, destAta, owner, BCOOK_MINT),
    depositIx,
  );

  const signature = await signSendConfirm(conn, tx, [keypair, ephemeral], "stake");
  const estBcook = estimateBcookOut(amountUi, pool.rate);
  return {
    signature,
    staked: { amount: String(args.amount), symbol: COOK_SYMBOL },
    received: { estimate: estBcook.toFixed(BCOOK_DECIMALS), symbol: "bCOOK" },
    rate: pool.rate,
    explorerUrl: explorerTxUrl(signature),
  };
}

export interface UnstakeResult {
  signature: string;
  unstaked: { amount: string; symbol: string };
  received: { estimate: string; symbol: string };
  rate: number;
  explorerUrl: string;
}

// WithdrawSol (instruction 16): burns bCOOK and pays COOK from the reserve immediately —
// `poolTokens × rate × (1 − withdrawFee)`. Approves an ephemeral transfer authority for the burn.
export async function unstake(args: { amount: string | number }): Promise<UnstakeResult> {
  const { keypair } = requireWallet();
  const owner = keypair.publicKey;
  const conn = getConnection();

  const amountUi = Number(args.amount);
  const pool = await fetchStakePool(conn);
  assertWithinSpendCap(amountUi, pool.rate); // input is bCOOK, valued in COOK at the pool rate
  let poolTokens: bigint;
  try {
    poolTokens = uiToRaw(args.amount, BCOOK_DECIMALS);
  } catch {
    throw new CookieMcpError(`invalid amount "${args.amount}"`, "pass a positive bCOOK amount");
  }
  if (poolTokens <= 0n)
    throw new CookieMcpError("amount must be greater than 0", "pass a positive bCOOK amount");

  const sourceAta = getAssociatedTokenAddressSync(BCOOK_MINT, owner, true, TOKEN_PROGRAM_ID);
  const transferAuthority = Keypair.generate();

  const withdrawIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM,
    data: encodeStakeIxData(IX_WITHDRAW_SOL, poolTokens),
    keys: [
      { pubkey: STAKE_POOL, isSigner: false, isWritable: true },
      { pubkey: WITHDRAW_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: transferAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true }, // destination = wallet
      { pubkey: MANAGER_FEE, isSigner: false, isWritable: true },
      { pubkey: BCOOK_MINT, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });

  const tx = new Transaction().add(
    createApproveInstruction(sourceAta, transferAuthority.publicKey, owner, poolTokens),
    withdrawIx,
  );

  const signature = await signSendConfirm(conn, tx, [keypair, transferAuthority], "unstake");
  const estCook = estimateCookOut(amountUi, pool.rate);
  return {
    signature,
    unstaked: { amount: String(args.amount), symbol: "bCOOK" },
    received: { estimate: estCook.toFixed(COOK_DECIMALS), symbol: COOK_SYMBOL },
    rate: pool.rate,
    explorerUrl: explorerTxUrl(signature),
  };
}
