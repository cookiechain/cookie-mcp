// Cookiebox DAMM v2 (cp-amm) liquidity ops: add_liquidity, remove_liquidity, lock_liquidity.
//
// ⚠️ UNVALIDATED. These move real liquidity through a forked cp-amm program; the SDK derives some
// accounts internally, and LP can't be dust-tested like swaps. They are exposed ONLY when
// COOKIE_ENABLE_UNVALIDATED_LP=1 and must be validated on a funded wallet before that gate is removed.
// Where possible we pass explicit accounts derived against Cookie's program so we control every key.
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import BN from "bn.js";

import { COOK_MINT, explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { getConnection } from "../rpc";
import { requireWallet, assertWithinSpendCap } from "../wallet";
import { uiToRaw } from "../format";
import { fetchTokens } from "../cookiescan";
import { buildCpAmmDeps, deriveTokenVault, type CpAmmDeps } from "./cpAmm";

export const LP_ENABLED = process.env.COOKIE_ENABLE_UNVALIDATED_LP === "1";

/** Resolve a mint's decimals + owning token program from chain. */
async function resolveMint(
  conn: Connection,
  mint: PublicKey,
): Promise<{ decimals: number; program: PublicKey }> {
  const info = await conn.getParsedAccountInfo(mint);
  const data = info.value?.data;
  if (!info.value || !data || !("parsed" in data)) {
    throw new CookieMcpError(
      `mint ${mint.toBase58()} not found on-chain`,
      "check the mint address",
    );
  }
  return {
    decimals: (data.parsed as { info: { decimals: number } }).info.decimals,
    program: info.value.owner,
  };
}

interface PoolCtx {
  deps: CpAmmDeps;
  pool: PublicKey;
  state: {
    tokenAMint: PublicKey;
    tokenBMint: PublicKey;
    tokenAVault: PublicKey;
    tokenBVault: PublicKey;
    sqrtPrice: BN;
    sqrtMinPrice: BN;
    sqrtMaxPrice: BN;
    collectFeeMode: number;
    liquidity: BN;
  };
  aProgram: PublicKey;
  bProgram: PublicKey;
  aDecimals: number;
  bDecimals: number;
}

async function loadPool(conn: Connection, poolStr: string): Promise<PoolCtx> {
  let pool: PublicKey;
  try {
    pool = new PublicKey(poolStr);
  } catch {
    throw new CookieMcpError(`invalid pool address: ${poolStr}`, "pass a valid DAMM pool pubkey");
  }
  const deps = buildCpAmmDeps(conn);
  let state: PoolCtx["state"];
  try {
    state = (await deps.cpAmm.fetchPoolState(pool)) as unknown as PoolCtx["state"];
  } catch {
    throw new CookieMcpError(
      `no Cookiebox DAMM v2 pool at ${pool.toBase58()}`,
      "pass a cookiebox-damm pool address (see get_pools)",
    );
  }
  const [a, b] = await Promise.all([
    resolveMint(conn, state.tokenAMint),
    resolveMint(conn, state.tokenBMint),
  ]);
  return {
    deps,
    pool,
    state,
    aProgram: a.program,
    bProgram: b.program,
    aDecimals: a.decimals,
    bDecimals: b.decimals,
  };
}

/** COOK price (native) for the spend-cap valuation of a deposited token. */
async function priceCookOf(mint: string): Promise<number | null> {
  if (mint === COOK_MINT) return 1;
  const t = (await fetchTokens()).find((x) => x.mint === mint);
  return t?.price?.native ?? null;
}

async function signSendConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
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
        "simulation failed: blockhash not found",
        "Cookie Chain finalization may be stalled — check chain_health; retry",
      );
    }
    throw new CookieMcpError(
      `simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "check balances and pool state; LP ops are UNVALIDATED — verify on a test wallet first",
    );
  }
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

function ensureEnabled(): void {
  if (!LP_ENABLED) {
    throw new CookieMcpError(
      "DAMM liquidity tools are disabled (unvalidated)",
      "set COOKIE_ENABLE_UNVALIDATED_LP=1 to opt in; these move real liquidity and are pending live validation",
    );
  }
}

export interface LpResult {
  signature: string;
  pool: string;
  explorerUrl: string;
  note: string;
}
const UNVALIDATED_NOTE = "UNVALIDATED cp-amm fork op — verify the result on cookiescan.io";

export async function addLiquidity(args: {
  poolPk: string;
  amountA?: string | number;
  amountB?: string | number;
}): Promise<LpResult> {
  ensureEnabled();
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const owner = keypair.publicKey;

  if (args.amountA == null && args.amountB == null) {
    throw new CookieMcpError(
      "provide amountA and/or amountB",
      "specify how much of each token to add",
    );
  }
  const maxA = args.amountA != null ? uiToRaw(args.amountA, ctx.aDecimals) : 0n;
  const maxB = args.amountB != null ? uiToRaw(args.amountB, ctx.bDecimals) : 0n;

  // Spend cap on whichever side is COOK (best-effort; both sides valued in COOK when priced).
  const capA = ctx.state.tokenAMint.toBase58();
  const capB = ctx.state.tokenBMint.toBase58();
  if (maxA > 0n) assertWithinSpendCap(Number(args.amountA), await priceCookOf(capA));
  if (maxB > 0n) assertWithinSpendCap(Number(args.amountB), await priceCookOf(capB));

  const liquidityDelta = ctx.deps.cpAmm.getLiquidityDelta({
    maxAmountTokenA: new BN(maxA.toString()),
    maxAmountTokenB: new BN(maxB.toString()),
    sqrtPrice: ctx.state.sqrtPrice,
    sqrtMinPrice: ctx.state.sqrtMinPrice,
    sqrtMaxPrice: ctx.state.sqrtMaxPrice,
    collectFeeMode: ctx.state.collectFeeMode,
  } as never);

  const positionNft = Keypair.generate();
  const tx = (await ctx.deps.cpAmm.createPositionAndAddLiquidity({
    owner,
    pool: ctx.pool,
    positionNft: positionNft.publicKey,
    liquidityDelta,
    maxAmountTokenA: new BN(maxA.toString()),
    maxAmountTokenB: new BN(maxB.toString()),
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
  } as never)) as unknown as Transaction;

  const signature = await signSendConfirm(conn, tx, [keypair, positionNft]);
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: UNVALIDATED_NOTE,
  };
}

/** Find the wallet's position in a pool (the one with the most liquidity). */
async function firstPosition(ctx: PoolCtx, owner: PublicKey) {
  const positions = (await ctx.deps.cpAmm.getUserPositionByPool(
    ctx.pool,
    owner,
  )) as unknown as Array<{
    positionNftAccount: PublicKey;
    position: PublicKey;
    positionState: { unlockedLiquidity: BN };
  }>;
  if (!positions.length) {
    throw new CookieMcpError(
      "no position found for this wallet in that pool",
      "add liquidity first, or check the pool address",
    );
  }
  return positions[0]!;
}

export async function removeLiquidity(args: { poolPk: string; bps?: number }): Promise<LpResult> {
  ensureEnabled();
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const pos = await firstPosition(ctx, keypair.publicKey);
  const bps = args.bps ?? 10_000;
  const unlocked = pos.positionState.unlockedLiquidity;

  const common = {
    owner: keypair.publicKey,
    position: pos.position,
    pool: ctx.pool,
    positionNftAccount: pos.positionNftAccount,
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    tokenAVault: deriveTokenVault(ctx.state.tokenAMint, ctx.pool),
    tokenBVault: deriveTokenVault(ctx.state.tokenBMint, ctx.pool),
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
    vestings: [],
  };

  const tx = (await (bps >= 10_000
    ? ctx.deps.cpAmm.removeAllLiquidity(common as never)
    : ctx.deps.cpAmm.removeLiquidity({
        ...common,
        liquidityDelta: unlocked.mul(new BN(bps)).div(new BN(10_000)),
      } as never))) as unknown as Transaction;

  const signature = await signSendConfirm(conn, tx, [keypair]);
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: UNVALIDATED_NOTE,
  };
}

export async function lockLiquidity(args: { poolPk: string }): Promise<LpResult> {
  ensureEnabled();
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const pos = await firstPosition(ctx, keypair.publicKey);

  const tx = (await ctx.deps.cpAmm.permanentLockPosition({
    owner: keypair.publicKey,
    position: pos.position,
    positionNftAccount: pos.positionNftAccount,
    pool: ctx.pool,
    unlockedLiquidity: pos.positionState.unlockedLiquidity,
  } as never)) as unknown as Transaction;

  const signature = await signSendConfirm(conn, tx, [keypair]);
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: UNVALIDATED_NOTE,
  };
}
