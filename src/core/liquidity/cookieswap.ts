// CookieSwap SAMM (Raydium-CLMM fork, WTzk…) liquidity, via @raydium-io/raydium-sdk-v2.
//
// Concentrated-liquidity ops on Cookie's forked program, live-verified on Cookie Chain.
// getPoolInfoFromRpc auto-retargets to the pool's own program (poolKeys.programId == WTzk…), so the
// high-level raydium.clmm.* builders work on the fork. add_liquidity opens a full-range position by
// default; create_pool initializes a new pool on a chosen fork ammConfig, then seeds it full-range.
import { PublicKey, type Keypair, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Raydium, TxVersion, PoolUtils, ClmmConfigLayout } from "@raydium-io/raydium-sdk-v2";

import { COOK_MINT, DEFAULT_SLIPPAGE_BPS, explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { fetchTokens } from "../cookiescan";
import { assertWithinSpendCap } from "../wallet";
import { uiToRaw } from "../format";

export const SAMM_PROGRAM_ID = "WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5";

// Default fork AmmConfig for create_pool (the canonical COOK config: tickSpacing 100, 1% trade fee).
// Override per call with `ammConfig`. A pool is keyed by (ammConfig, mintA, mintB) — creating a pair
// that already exists on this config fails, so pick a different config for a duplicate pair.
export const SAMM_DEFAULT_AMM_CONFIG = "JDjWtzVe7TXHjjSqFoL1QSfv8arrCqHPPoBXaUqbe9X4";

// Raydium CLMM hard tick bounds; a full-range position spans these (aligned to the pool's tickSpacing).
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

/** The widest tick range aligned to a pool's tick spacing (a full-range position). */
export function fullRangeTicks(spacing: number): { tickLower: number; tickUpper: number } {
  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  };
}

/**
 * Initial pool price (mintB per mintA, canonical order): explicit `initialPrice` if given, else the
 * deposit ratio bUi/aUi. Throws when neither yields a positive, finite price.
 */
export function resolveInitialPrice(
  initialPrice: string | number | undefined,
  aUi: number,
  bUi: number,
): Decimal {
  const price =
    initialPrice != null
      ? new Decimal(initialPrice.toString())
      : new Decimal(bUi || 0).div(aUi || 1);
  if (!price.isFinite() || price.lte(0)) {
    throw new CookieMcpError(
      "cannot determine an initial price",
      "provide `initialPrice`, or non-zero amountA and amountB",
    );
  }
  return price;
}

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

  const { tickLower, tickUpper } = fullRangeTicks(poolInfo.config.tickSpacing);

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

/** Resolve a mint's decimals + owning token program from chain. */
async function resolveMint(
  conn: Connection,
  mint: PublicKey,
): Promise<{ decimals: number; program: string }> {
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
    program: info.value.owner.toBase58(),
  };
}

/**
 * Create a CookieSwap SAMM (Raydium-CLMM fork) pool, then seed it with a full-range position. The pool
 * is keyed by (ammConfig, mintA, mintB); `ammConfig` selects the fee tier / tick spacing (default the
 * canonical COOK config). Initial price (mintB per mintA, canonical order) comes from `initialPrice` or
 * the deposit ratio. Raydium `createPool` only initializes the pool, so we seed it afterwards via the
 * same full-range add path.
 */
export async function createSammPool(
  conn: Connection,
  keypair: Keypair,
  args: {
    tokenAMint: string;
    tokenBMint: string;
    amountA: string | number;
    amountB: string | number;
    ammConfig?: string;
    initialPrice?: string | number;
  },
): Promise<SammLpResult> {
  const raydium = await loadRaydium(conn, keypair);

  let cfgPk: PublicKey;
  try {
    cfgPk = new PublicKey(args.ammConfig ?? SAMM_DEFAULT_AMM_CONFIG);
  } catch {
    throw new CookieMcpError(
      `invalid ammConfig address: ${args.ammConfig}`,
      "omit `ammConfig` to use the default SAMM fee tier",
    );
  }
  const cfgAcct = await conn.getAccountInfo(cfgPk);
  if (!cfgAcct || cfgAcct.owner.toBase58() !== SAMM_PROGRAM_ID) {
    throw new CookieMcpError(
      `${cfgPk.toBase58()} is not a CookieSwap SAMM AmmConfig`,
      "pass a valid SAMM ammConfig address, or omit it for the default",
    );
  }
  const cfg = ClmmConfigLayout.decode(cfgAcct.data) as {
    index: number;
    protocolFeeRate: number;
    tradeFeeRate: number;
    tickSpacing: number;
    fundFeeRate?: number;
  };
  const ammConfig = {
    id: cfgPk,
    index: cfg.index,
    protocolFeeRate: cfg.protocolFeeRate,
    tradeFeeRate: cfg.tradeFeeRate,
    tickSpacing: cfg.tickSpacing,
    fundFeeRate: cfg.fundFeeRate ?? 0,
    fundOwner: "",
    description: "",
  };

  // Canonical Raydium ordering (mint1 < mint2), keeping each side's amount + program aligned.
  const x = {
    mint: new PublicKey(args.tokenAMint),
    str: args.tokenAMint,
    ui: Number(args.amountA),
  };
  const y = {
    mint: new PublicKey(args.tokenBMint),
    str: args.tokenBMint,
    ui: Number(args.amountB),
  };
  const [a, b] = Buffer.compare(x.mint.toBuffer(), y.mint.toBuffer()) < 0 ? [x, y] : [y, x];
  const [ma, mb] = await Promise.all([resolveMint(conn, a.mint), resolveMint(conn, b.mint)]);

  // Cap the COOK side (a brand-new token side usually has no price → not capped).
  for (const side of [a, b]) {
    const price = await priceCookOf(side.str);
    if (price != null) assertWithinSpendCap(side.ui, price);
  }

  const price = resolveInitialPrice(args.initialPrice, a.ui, b.ui);

  const token = (addr: string, decimals: number, program: string) => ({
    chainId: 101,
    address: addr,
    programId: program,
    logoURI: "",
    symbol: "",
    name: "",
    decimals,
    tags: [],
    extensions: {},
  });

  const built = await raydium.clmm.createPool({
    programId: new PublicKey(SAMM_PROGRAM_ID),
    mint1: token(a.mint.toBase58(), ma.decimals, ma.program),
    mint2: token(b.mint.toBase58(), mb.decimals, mb.program),
    ammConfig,
    initialPrice: price,
    txVersion: TxVersion.V0,
  } as never);

  const extAddr = (built as { extInfo?: { address?: { poolId?: string; id?: string } } }).extInfo
    ?.address;
  const poolPk = extAddr?.poolId ?? extAddr?.id;
  if (!poolPk) {
    throw new CookieMcpError(
      "SAMM createPool did not return a pool address",
      "this is a bug — the Raydium builder shape changed",
    );
  }
  await execTx(built as never);

  // Seed the new pool full-range. The pool's mintA == the canonically-smaller mint (a), so amountA→a.
  const seed = await addSammLiquidity(conn, keypair, {
    poolPk,
    amountA: a.ui,
    amountB: b.ui,
  });
  return {
    signature: seed.signature,
    pool: poolPk,
    explorerUrl: explorerTxUrl(seed.signature),
    note: NOTE,
  };
}
