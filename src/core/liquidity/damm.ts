// Cookiebox DAMM v2 (cp-amm) liquidity ops: add_liquidity, remove_liquidity, lock_liquidity, create_pool.
//
// These move real liquidity through Cookie's forked cp-amm program. The @meteora-ag/cp-amm-sdk's
// high-level position-creating and position-finding paths derive PDAs against Meteora's *mainnet*
// program id, which fails on the fork (ConstraintSeeds), so we build those instructions ourselves via
// the Cookie anchor Program with Cookie-derived accounts (see ./cpAmm.ts). All ops are live-verified on
// Cookie Chain. Simulate-before-send on every op.
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";

import { explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { getConnection } from "../rpc";
import { requireWallet } from "../wallet";
import { uiToRaw } from "../format";
import { signSendConfirm, LP_NOTE } from "./send";
import {
  buildCpAmmDeps,
  buildCreatePositionAndAddLiquidityTx,
  buildCreatePoolTx,
  buildRemoveLiquidityTx,
  buildClaimPositionFeeTx,
  buildLockPositionTx,
  getUserPositions,
  deriveTokenVault,
  derivePoolAddress,
  DAMM_CREATE_CONFIG,
  type CpAmmDeps,
} from "./cpAmm";

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

export interface LpResult {
  signature: string;
  pool: string;
  explorerUrl: string;
  note: string;
}

export async function addLiquidity(args: {
  poolPk: string;
  amountA?: string | number;
  amountB?: string | number;
}): Promise<LpResult> {
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

  const liquidityDelta = ctx.deps.cpAmm.getLiquidityDelta({
    maxAmountTokenA: new BN(maxA.toString()),
    maxAmountTokenB: new BN(maxB.toString()),
    sqrtPrice: ctx.state.sqrtPrice,
    sqrtMinPrice: ctx.state.sqrtMinPrice,
    sqrtMaxPrice: ctx.state.sqrtMaxPrice,
    collectFeeMode: ctx.state.collectFeeMode,
  } as never) as unknown as BN;

  const positionNft = Keypair.generate();
  const tx = await buildCreatePositionAndAddLiquidityTx({
    deps: ctx.deps,
    owner,
    pool: ctx.pool,
    positionNft: positionNft.publicKey,
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
    liquidityDelta,
    maxAmountTokenA: new BN(maxA.toString()),
    maxAmountTokenB: new BN(maxB.toString()),
    // Thresholds are the MAX each side may cost (upward slippage bound); the deposit for liquidityDelta
    // is ≤ these by construction.
    tokenAAmountThreshold: new BN(maxA.toString()),
    tokenBAmountThreshold: new BN(maxB.toString()),
  });

  const signature = await signSendConfirm(conn, tx, [keypair, positionNft], "add_liquidity");
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: LP_NOTE,
  };
}

/** Find the wallet's position in a pool (the one with the most liquidity). */
async function firstPosition(ctx: PoolCtx, owner: PublicKey) {
  const positions = await getUserPositions(ctx.deps, getConnection(), owner, ctx.pool);
  if (!positions.length) {
    throw new CookieMcpError(
      "no position found for this wallet in that pool",
      "add liquidity first, or check the pool address",
    );
  }
  return positions[0]!;
}

export async function removeLiquidity(args: { poolPk: string; bps?: number }): Promise<LpResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const pos = await firstPosition(ctx, keypair.publicKey);
  const bps = args.bps ?? 10_000;
  const unlocked = pos.positionState.unlockedLiquidity;

  const tx = await buildRemoveLiquidityTx({
    deps: ctx.deps,
    owner: keypair.publicKey,
    pool: ctx.pool,
    position: pos.position,
    positionNftAccount: pos.positionNftAccount,
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    tokenAVault: deriveTokenVault(ctx.state.tokenAMint, ctx.pool),
    tokenBVault: deriveTokenVault(ctx.state.tokenBMint, ctx.pool),
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
    liquidityDelta: bps >= 10_000 ? null : unlocked.mul(new BN(bps)).div(new BN(10_000)),
  });

  const signature = await signSendConfirm(conn, tx, [keypair], "remove_liquidity");
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: LP_NOTE,
  };
}

export async function claimFees(args: { poolPk: string }): Promise<LpResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const pos = await firstPosition(ctx, keypair.publicKey);

  const tx = await buildClaimPositionFeeTx({
    deps: ctx.deps,
    owner: keypair.publicKey,
    pool: ctx.pool,
    position: pos.position,
    positionNftAccount: pos.positionNftAccount,
    tokenAMint: ctx.state.tokenAMint,
    tokenBMint: ctx.state.tokenBMint,
    tokenAVault: deriveTokenVault(ctx.state.tokenAMint, ctx.pool),
    tokenBVault: deriveTokenVault(ctx.state.tokenBMint, ctx.pool),
    tokenAProgram: ctx.aProgram,
    tokenBProgram: ctx.bProgram,
  });

  const signature = await signSendConfirm(conn, tx, [keypair], "claim_fees");
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: LP_NOTE,
  };
}

export async function lockLiquidity(args: { poolPk: string }): Promise<LpResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const ctx = await loadPool(conn, args.poolPk);
  const pos = await firstPosition(ctx, keypair.publicKey);

  const tx = await buildLockPositionTx({
    deps: ctx.deps,
    owner: keypair.publicKey,
    pool: ctx.pool,
    position: pos.position,
    positionNftAccount: pos.positionNftAccount,
    unlockedLiquidity: pos.positionState.unlockedLiquidity,
  });

  const signature = await signSendConfirm(conn, tx, [keypair], "lock_liquidity");
  return {
    signature,
    pool: ctx.pool.toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: LP_NOTE,
  };
}

export async function createPool(args: {
  tokenAMint: string;
  tokenBMint: string;
  amountA: string | number;
  amountB: string | number;
  config?: string;
}): Promise<LpResult> {
  const { keypair } = requireWallet();
  const conn = getConnection();
  const owner = keypair.publicKey;
  const deps = buildCpAmmDeps(conn);

  let configPk: PublicKey;
  try {
    configPk = args.config ? new PublicKey(args.config) : DAMM_CREATE_CONFIG;
  } catch {
    throw new CookieMcpError(
      `invalid config address: ${args.config}`,
      "omit `config` to use the default",
    );
  }
  const configState = (await deps.cpAmm.fetchConfigState(configPk)) as unknown as {
    sqrtMinPrice: BN;
    sqrtMaxPrice: BN;
    collectFeeMode: number;
  };

  // Canonical cp-amm ordering: tokenA < tokenB by pubkey. Keep each side's amount + program aligned.
  const rawA = await (async () => {
    const m = new PublicKey(args.tokenAMint);
    const meta = await resolveMint(conn, m);
    return {
      mint: m,
      str: args.tokenAMint,
      ui: Number(args.amountA),
      raw: new BN(uiToRaw(args.amountA, meta.decimals).toString()),
      program: meta.program,
    };
  })();
  const rawB = await (async () => {
    const m = new PublicKey(args.tokenBMint);
    const meta = await resolveMint(conn, m);
    return {
      mint: m,
      str: args.tokenBMint,
      ui: Number(args.amountB),
      raw: new BN(uiToRaw(args.amountB, meta.decimals).toString()),
      program: meta.program,
    };
  })();
  const [a, b] =
    Buffer.compare(rawA.mint.toBuffer(), rawB.mint.toBuffer()) < 0 ? [rawA, rawB] : [rawB, rawA];

  const { initSqrtPrice, liquidityDelta } = deps.cpAmm.preparePoolCreationParams({
    tokenAAmount: a.raw,
    tokenBAmount: b.raw,
    minSqrtPrice: configState.sqrtMinPrice,
    maxSqrtPrice: configState.sqrtMaxPrice,
    collectFeeMode: configState.collectFeeMode,
  } as never) as unknown as { initSqrtPrice: BN; liquidityDelta: BN };

  const positionNft = Keypair.generate();
  const tx = await buildCreatePoolTx({
    deps,
    owner,
    config: configPk,
    positionNft: positionNft.publicKey,
    tokenAMint: a.mint,
    tokenBMint: b.mint,
    tokenAProgram: a.program,
    tokenBProgram: b.program,
    initSqrtPrice,
    liquidityDelta,
    tokenAAmount: a.raw,
    tokenBAmount: b.raw,
  });

  const signature = await signSendConfirm(conn, tx, [keypair, positionNft], "create_pool");
  return {
    signature,
    pool: derivePoolAddress(configPk, a.mint, b.mint).toBase58(),
    explorerUrl: explorerTxUrl(signature),
    note: LP_NOTE,
  };
}
