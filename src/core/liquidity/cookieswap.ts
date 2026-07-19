// CookieSwap SAMM (Raydium-CLMM fork, WTzk…) liquidity, via @raydium-io/raydium-sdk-v2.
//
// Concentrated-liquidity ops on Cookie's forked program, live-verified on Cookie Chain.
// getPoolInfoFromRpc auto-retargets to the pool's own program (poolKeys.programId == WTzk…), so the
// high-level raydium.clmm.* builders work on the fork. add_liquidity opens a full-range position by
// default; SAMM create_pool is deferred (needs fork ammConfig + tick-spacing + initial-price selection).
import { type Keypair, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { Raydium, TxVersion, PoolUtils } from "@raydium-io/raydium-sdk-v2";

import { COOK_MINT, DEFAULT_SLIPPAGE_BPS, explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { fetchTokens } from "../cookiescan";
import { assertWithinSpendCap } from "../wallet";
import { uiToRaw } from "../format";

export const SAMM_PROGRAM_ID = "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5";

// Raydium CLMM hard tick bounds; a full-range position spans these (aligned to the pool's tickSpacing).
const MIN_TICK = -443636;
const MAX_TICK = 443636;

export interface SammLpResult {
  signature: string;
  pool: string;
  explorerUrl: string;
  note: string;
}
const NOTE = "verify the result on cookiescan.io";

async function loadRaydium(connection: Connection, keypair: Keypair): Promise<Raydium> {
  return Raydium.load({
    connection,
    owner: keypair,
    cluster: "mainnet",
    disableLoadToken: true,
    disableFeatureCheck: true,
  });
}

// Raydium `MakeTxData`: sign with owner + ephemeral signers and send over our connection.
async function execTx(built: {
  execute: (o?: { sendAndConfirm?: boolean }) => Promise<{ txId: string }>;
}): Promise<string> {
  const { txId } = await built.execute({ sendAndConfirm: true });
  return txId;
}

async function priceCookOf(mint: string): Promise<number | null> {
  if (mint === COOK_MINT) return 1;
  const t = (await fetchTokens()).find((x) => x.mint === mint);
  return t?.price?.native ?? null;
}

export async function addSammLiquidity(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string; amountA?: string | number; amountB?: string | number },
): Promise<SammLpResult> {
  if (args.amountA == null && args.amountB == null) {
    throw new CookieMcpError("provide amountA and/or amountB", "specify how much to deposit");
  }
  const raydium = await loadRaydium(conn, keypair);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(args.poolPk);

  const decA = poolInfo.mintA.decimals;
  const decB = poolInfo.mintB.decimals;
  const useA = args.amountA != null;
  const uiAmount = Number(useA ? args.amountA : args.amountB);
  const baseAmount = new BN(
    uiToRaw(useA ? args.amountA! : args.amountB!, useA ? decA : decB).toString(),
  );

  // Cap whichever side is COOK (a new/unpriced token side isn't capped).
  const sideMint = useA ? poolInfo.mintA.address : poolInfo.mintB.address;
  const price = await priceCookOf(sideMint);
  if (price != null) assertWithinSpendCap(uiAmount, price);

  const spacing = poolInfo.config.tickSpacing;
  const tickLower = Math.ceil(MIN_TICK / spacing) * spacing;
  const tickUpper = Math.floor(MAX_TICK / spacing) * spacing;

  // Compute the slippage-adjusted paired amount for otherAmountMax. Must be a real bound: for a
  // native-COOK side Raydium wraps exactly this many lamports, so a u64-max sentinel overflows.
  const q = (await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    inputA: useA,
    tickLower,
    tickUpper,
    amount: baseAmount,
    slippage: DEFAULT_SLIPPAGE_BPS / 10_000,
    add: true,
    epochInfo: await conn.getEpochInfo(),
    amountHasFee: false,
  } as never)) as unknown as { amountSlippageA: { amount: BN }; amountSlippageB: { amount: BN } };
  const otherAmountMax = useA ? q.amountSlippageB.amount : q.amountSlippageA.amount;

  const built = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    tickLower,
    tickUpper,
    base: useA ? "MintA" : "MintB",
    baseAmount,
    otherAmountMax,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  } as never);

  const signature = await execTx(built as never);
  return { signature, pool: args.poolPk, explorerUrl: explorerTxUrl(signature), note: NOTE };
}

export async function removeSammLiquidity(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string },
): Promise<SammLpResult> {
  const raydium = await loadRaydium(conn, keypair);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(args.poolPk);

  const positions = await raydium.clmm.getOwnerPositionInfo({ programId: SAMM_PROGRAM_ID });
  const pos = (positions as Array<{ poolId: { toBase58(): string }; liquidity: BN }>).find(
    (p) => p.poolId.toBase58() === args.poolPk,
  );
  if (!pos) {
    throw new CookieMcpError(
      "no SAMM position found for this wallet in that pool",
      "add liquidity first, or check the pool address",
    );
  }

  const built = await raydium.clmm.decreaseLiquidity({
    poolInfo,
    poolKeys,
    ownerPosition: pos,
    ownerInfo: { useSOLBalance: true, closePosition: true },
    liquidity: pos.liquidity,
    amountMinA: new BN(0),
    amountMinB: new BN(0),
    txVersion: TxVersion.V0,
  } as never);

  const signature = await execTx(built as never);
  return { signature, pool: args.poolPk, explorerUrl: explorerTxUrl(signature), note: NOTE };
}

export async function claimSammFees(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string },
): Promise<SammLpResult> {
  const raydium = await loadRaydium(conn, keypair);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(args.poolPk);

  const positions = await raydium.clmm.getOwnerPositionInfo({ programId: SAMM_PROGRAM_ID });
  const pos = (positions as Array<{ poolId: { toBase58(): string }; liquidity: BN }>).find(
    (p) => p.poolId.toBase58() === args.poolPk,
  );
  if (!pos) {
    throw new CookieMcpError(
      "no SAMM position found for this wallet in that pool",
      "add liquidity first, or check the pool address",
    );
  }

  // CLMM has no dedicated fee-collect ix: decreaseLiquidity by 0 sweeps accrued swap fees (+ rewards)
  // to the owner without touching principal, and keeps the position open.
  const built = await raydium.clmm.decreaseLiquidity({
    poolInfo,
    poolKeys,
    ownerPosition: pos,
    ownerInfo: { useSOLBalance: true, closePosition: false },
    liquidity: new BN(0),
    amountMinA: new BN(0),
    amountMinB: new BN(0),
    txVersion: TxVersion.V0,
  } as never);

  const signature = await execTx(built as never);
  return { signature, pool: args.poolPk, explorerUrl: explorerTxUrl(signature), note: NOTE };
}

export function createSammPool(): never {
  throw new CookieMcpError(
    "creating a CookieSwap SAMM pool is not supported yet",
    "SAMM pool creation needs fork ammConfig + tick-spacing + initial-price selection — use add_liquidity on an existing SAMM pool",
  );
}
