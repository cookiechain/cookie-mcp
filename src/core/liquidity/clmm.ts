// Cookiebox CLMM (Orca Whirlpool fork, CLMMmWqTt…) liquidity ops: add / remove / claim_fees / create.
//
// Unlike cp-amm (DAMM), the Orca SDK derives EVERY PDA from `ctx.program.programId`, which it reads
// from the anchor Program. So building the Program from `{...whirlpoolIdl, address: CLMM_PROGRAM_ID}`
// retargets all derivations to Cookie's fork and the SDK's high-level WhirlpoolClient methods work
// directly (see cookiebox src/solana/clmm/*). The ONE fork trap the IDL retarget can't fix: Orca
// hardcodes its mainnet position-NFT metadata-update-authority into openPositionWithMetadata ixs — that
// pubkey is invalid on Cookie Chain, so we rewrite it to the Cookie treasury (patchMetadataAuth) before
// signing. Every op routes through the shared simulate-first / spend-capped sender.
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type Signer,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import anchorPkg, { type Idl, type Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  PDAUtil,
  PriceMath,
  TickUtil,
  TokenExtensionUtil,
  decreaseLiquidityQuoteByLiquidity,
  type WhirlpoolClient,
  type Whirlpool,
} from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";
import type { TransactionBuilder } from "@orca-so/common-sdk";

import { COOK_MINT, DEFAULT_SLIPPAGE_BPS, explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { assertWithinSpendCap } from "../wallet";
import { uiToRaw } from "../format";
import { fetchTokens } from "../cookiescan";
import { signSendConfirm, LP_NOTE } from "./send";
import whirlpoolIdl from "../../idl/whirlpool.json" with { type: "json" };

const { AnchorProvider, Wallet } = anchorPkg;

export const CLMM_PROGRAM_ID = new PublicKey("CLMMmWqTtyNSomqXP3kETJy2SGKPdr31USsm4GfbLyKs");

/** WhirlpoolsConfig for permissionless CLMM pool creation + pool PDA derivation (Cookie deployment). */
const WHIRLPOOL_CONFIG_ADDRESS = new PublicKey("7g1wZSihBx7TVx9Q1gtKh874RuJYviCaTw9EfLE2pPzX");

/** Cookie CLMM protocol treasury — also the Metaplex position-NFT metadata update authority on Cookie. */
export const WHIRLPOOL_TREASURY = new PublicKey("Ba59QdKR9fYJ362zFWLmscBF625qsMmFategLzRSRZv2");

/** Orca mainnet position-NFT metadata update authority — invalid on Cookie; patched to the treasury. */
export const ORCA_METADATA_UPDATE_AUTH = new PublicKey(
  "3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr",
);

const OPEN_POSITION_CU = 500_000;
const INIT_POOL_CU = 400_000;

/** Static fee tiers Cookie CLMM exposes: display bps → tickSpacing. Default 0.25% (tickSpacing 2). */
export const CLMM_FEE_TIER_TICK_SPACING: Record<number, number> = {
  25: 2,
  30: 64,
  100: 128,
  200: 256,
  400: 96,
};
export const DEFAULT_CLMM_FEE_TIER_BPS = 25;

export interface ClmmLpResult {
  signature: string;
  pool: string;
  explorerUrl: string;
  note: string;
}

// --- client + tx plumbing -------------------------------------------------------------------------

/** Build a WhirlpoolClient retargeted to Cookie's CLMM program (IDL address merge). */
export function buildClmmClient(conn: Connection, keypair: Keypair): WhirlpoolClient {
  const provider = new AnchorProvider(conn, new Wallet(keypair), { commitment: "confirmed" });
  const program = new anchorPkg.Program(
    { ...(whirlpoolIdl as Idl), address: CLMM_PROGRAM_ID.toBase58() },
    provider,
  ) as unknown as Program;
  if (!program.programId.equals(CLMM_PROGRAM_ID)) {
    throw new CookieMcpError(
      "CLMM program id mismatch after IDL retarget",
      "this is a bug — the whirlpool IDL address override did not take",
    );
  }
  const ctx = WhirlpoolContext.fromWorkspace(provider, program as never);
  return buildWhirlpoolClient(ctx);
}

/** Rewrite Orca's hardcoded mainnet metadata-update-auth to the Cookie treasury (in place). */
export function patchMetadataAuth(tx: Transaction): void {
  for (const ix of tx.instructions) {
    for (let i = 0; i < ix.keys.length; i++) {
      if (ix.keys[i]!.pubkey.equals(ORCA_METADATA_UPDATE_AUTH)) {
        ix.keys[i] = { ...ix.keys[i]!, pubkey: WHIRLPOOL_TREASURY };
      }
    }
  }
}

/** Turn an Orca TransactionBuilder into a legacy Transaction + its extra signers, metadata patched. */
async function builderToTx(
  builder: TransactionBuilder,
  computeUnits: number,
): Promise<{ tx: Transaction; signers: Signer[] }> {
  const payload = await builder.build({ maxSupportedTransactionVersion: "legacy" });
  const tx = payload.transaction;
  if (!(tx instanceof Transaction)) {
    throw new CookieMcpError(
      "expected a legacy transaction from the Orca builder",
      "this is a bug — CLMM txs must be legacy for our sender",
    );
  }
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  patchMetadataAuth(tx);
  return { tx, signers: payload.signers as Signer[] };
}

/** Build → send a single builder; returns its signature. keypair signs as fee payer + extra signers. */
async function sendBuilder(
  conn: Connection,
  keypair: Keypair,
  builder: TransactionBuilder,
  computeUnits: number,
): Promise<string> {
  const { tx, signers } = await builderToTx(builder, computeUnits);
  return signSendConfirm(conn, tx, [keypair, ...signers]);
}

/** Build → send a list of builders sequentially (skipping empty ones); returns the last signature. */
async function sendBuilders(
  conn: Connection,
  keypair: Keypair,
  builders: TransactionBuilder[],
  computeUnits: number,
): Promise<string> {
  let last = "";
  for (const b of builders) {
    if (b.isEmpty()) continue;
    last = await sendBuilder(conn, keypair, b, computeUnits);
  }
  if (!last) {
    throw new CookieMcpError("nothing to send", "the operation produced no instructions");
  }
  return last;
}

// --- helpers --------------------------------------------------------------------------------------

/** COOK price (native) for spend-cap valuation of a deposited token; 1 for COOK itself, null if unknown. */
async function priceCookOf(mint: string): Promise<number | null> {
  if (mint === COOK_MINT) return 1;
  const t = (await fetchTokens()).find((x) => x.mint === mint);
  return t?.price?.native ?? null;
}

/** Cap whichever side is COOK (best-effort; other priced tokens are also capped). */
async function capSide(mint: string, uiAmount: number): Promise<void> {
  if (uiAmount <= 0) return;
  const price = await priceCookOf(mint);
  if (price != null) assertWithinSpendCap(uiAmount, price);
}

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

interface OwnedPosition {
  positionAddress: PublicKey;
  positionMint: PublicKey;
  liquidity: BN;
}

/**
 * Find the wallet's CLMM position(s) in a pool. Enumerates position-NFT mints the wallet holds
 * (amount 1, decimals 0) across SPL + Token-2022, derives each position PDA against Cookie's program,
 * fetches them, keeps those in `poolPk`, and returns the largest-liquidity one first.
 * (Port of cookiebox fetchAllWalletClmmPositions, scoped to a pool.)
 */
export async function findClmmPosition(
  conn: Connection,
  client: WhirlpoolClient,
  owner: PublicKey,
  poolPk: PublicKey,
): Promise<OwnedPosition | null> {
  const [spl, spl2022] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const mints: PublicKey[] = [];
  for (const { account } of [...spl.value, ...spl2022.value]) {
    const parsed = (
      account.data as {
        parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number }; mint?: string } };
      }
    ).parsed?.info;
    if (parsed?.tokenAmount?.amount === "1" && parsed.tokenAmount.decimals === 0 && parsed.mint) {
      mints.push(new PublicKey(parsed.mint));
    }
  }
  if (mints.length === 0) return null;

  const pdas = mints.map((m) => PDAUtil.getPosition(CLMM_PROGRAM_ID, m).publicKey);
  const program = client.getContext().program as unknown as {
    account: {
      position: {
        fetchMultiple(a: PublicKey[], c?: string): Promise<Array<Record<string, unknown> | null>>;
      };
    };
  };
  const states = await program.account.position.fetchMultiple(pdas, "confirmed");

  const found: OwnedPosition[] = [];
  states.forEach((st, i) => {
    if (!st) return;
    const whirlpool = st.whirlpool as PublicKey;
    if (!whirlpool.equals(poolPk)) return;
    found.push({
      positionAddress: pdas[i]!,
      positionMint: mints[i]!,
      liquidity: new BN((st.liquidity as { toString(): string }).toString()),
    });
  });
  if (found.length === 0) return null;
  found.sort((a, b) => b.liquidity.cmp(a.liquidity));
  return found[0]!;
}

function noPositionError(): CookieMcpError {
  return new CookieMcpError(
    "no CLMM position found for this wallet in that pool",
    "add liquidity first, or check the pool address",
  );
}

function poolTokenDecimals(pool: Whirlpool): { decA: number; decB: number } {
  return { decA: pool.getTokenAInfo().decimals, decB: pool.getTokenBInfo().decimals };
}

function result(signature: string, pool: string): ClmmLpResult {
  return { signature, pool, explorerUrl: explorerTxUrl(signature), note: LP_NOTE };
}

// --- operations -----------------------------------------------------------------------------------

/**
 * Add liquidity to a CLMM pool. Opens a new full-range position by default (matching SAMM's default);
 * if the wallet already holds a position in the pool, deposits into it instead. Tick arrays are
 * initialized in a preceding tx when needed.
 */
export async function addClmmLiquidity(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string; amountA?: string | number; amountB?: string | number },
): Promise<ClmmLpResult> {
  if (args.amountA == null && args.amountB == null) {
    throw new CookieMcpError("provide amountA and/or amountB", "specify how much to deposit");
  }
  const client = buildClmmClient(conn, keypair);
  const owner = keypair.publicKey;
  let pool: Whirlpool;
  try {
    pool = await client.getPool(new PublicKey(args.poolPk));
  } catch {
    throw new CookieMcpError(
      `no Cookiebox CLMM pool at ${args.poolPk}`,
      "pass a cookiebox-clmm pool address (see get_pools)",
    );
  }
  await pool.refreshData();
  const data = pool.getData();
  const { decA, decB } = poolTokenDecimals(pool);

  const rawA = args.amountA != null ? new BN(uiToRaw(args.amountA, decA).toString()) : new BN(0);
  const rawB = args.amountB != null ? new BN(uiToRaw(args.amountB, decB).toString()) : new BN(0);
  await capSide(data.tokenMintA.toBase58(), Number(args.amountA ?? 0));
  await capSide(data.tokenMintB.toBase58(), Number(args.amountB ?? 0));

  const slippage = Percentage.fromFraction(DEFAULT_SLIPPAGE_BPS, 10_000);
  const { lowerBound, upperBound } = PriceMath.getSlippageBoundForSqrtPrice(
    data.sqrtPrice,
    slippage,
  );
  const depositParams = {
    tokenMaxA: rawA,
    tokenMaxB: rawB,
    minSqrtPrice: lowerBound[0],
    maxSqrtPrice: upperBound[0],
  };

  const existing = await findClmmPosition(conn, client, owner, pool.getAddress());
  if (existing) {
    const position = await client.getPosition(existing.positionAddress);
    await position.refreshData();
    const pd = position.getData();
    const tickInit = await pool.initTickArrayForTicks(
      [pd.tickLowerIndex, pd.tickUpperIndex],
      owner,
    );
    if (tickInit && !tickInit.isEmpty()) {
      await sendBuilder(conn, keypair, tickInit, OPEN_POSITION_CU);
    }
    const tx = await position.increaseLiquidity(depositParams, true, owner, owner, owner);
    const sig = await sendBuilder(conn, keypair, tx, OPEN_POSITION_CU);
    return result(sig, pool.getAddress().toBase58());
  }

  const [tickLower, tickUpper] = TickUtil.getFullRangeTickIndex(data.tickSpacing);
  const tickInit = await pool.initTickArrayForTicks([tickLower, tickUpper], owner);
  if (tickInit && !tickInit.isEmpty()) {
    await sendBuilder(conn, keypair, tickInit, OPEN_POSITION_CU);
  }
  const { tx } = await pool.openPositionWithMetadata(
    tickLower,
    tickUpper,
    depositParams,
    owner,
    owner,
  );
  const sig = await sendBuilder(conn, keypair, tx, OPEN_POSITION_CU);
  return result(sig, pool.getAddress().toBase58());
}

/**
 * Remove liquidity from the wallet's CLMM position. bps >= 10000 (default) closes the whole position;
 * a smaller bps decreases proportionally and keeps the position open.
 */
export async function removeClmmLiquidity(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string; bps?: number },
): Promise<ClmmLpResult> {
  const client = buildClmmClient(conn, keypair);
  const owner = keypair.publicKey;
  const poolPk = new PublicKey(args.poolPk);
  const pos = await findClmmPosition(conn, client, owner, poolPk);
  if (!pos) throw noPositionError();

  const pool = await client.getPool(poolPk);
  const slippage = Percentage.fromFraction(DEFAULT_SLIPPAGE_BPS, 10_000);
  const bps = args.bps ?? 10_000;

  if (bps >= 10_000) {
    const builders = await pool.closePosition(pos.positionAddress, slippage, owner, owner, owner);
    const sig = await sendBuilders(conn, keypair, builders, OPEN_POSITION_CU);
    return result(sig, poolPk.toBase58());
  }

  const position = await client.getPosition(pos.positionAddress);
  await Promise.all([pool.refreshData(), position.refreshData()]);
  const liquidity = position.getData().liquidity.mul(new BN(bps)).div(new BN(10_000));
  if (liquidity.lte(new BN(0))) {
    throw new CookieMcpError(
      "remove amount too small",
      "increase bps or remove the whole position",
    );
  }
  const fetcher = client.getFetcher();
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
    fetcher,
    pool.getData().tokenMintA,
    pool.getData().tokenMintB,
  );
  const quote = decreaseLiquidityQuoteByLiquidity(
    liquidity,
    slippage,
    position,
    pool,
    tokenExtensionCtx,
  );
  const tx = await position.decreaseLiquidity(
    {
      liquidityAmount: quote.liquidityAmount,
      tokenMinA: quote.tokenMinA,
      tokenMinB: quote.tokenMinB,
    },
    true,
    owner,
    owner,
    owner,
  );
  const sig = await sendBuilder(conn, keypair, tx, OPEN_POSITION_CU);
  return result(sig, poolPk.toBase58());
}

/** Sweep the position's accrued swap fees (+ rewards) to the wallet, keeping the position open. */
export async function claimClmmFees(
  conn: Connection,
  keypair: Keypair,
  args: { poolPk: string },
): Promise<ClmmLpResult> {
  const client = buildClmmClient(conn, keypair);
  const owner = keypair.publicKey;
  const poolPk = new PublicKey(args.poolPk);
  const pos = await findClmmPosition(conn, client, owner, poolPk);
  if (!pos) throw noPositionError();

  const builders = await client.collectFeesAndRewardsForPositions([pos.positionAddress]);
  const sig = await sendBuilders(conn, keypair, builders, OPEN_POSITION_CU);
  return result(sig, poolPk.toBase58());
}

/**
 * Create a CLMM pool for a token pair, then seed it with a full-range position. The initial price
 * (tokenB per tokenA, canonical order) comes from `initialPrice` or the deposit ratio. Fee tier
 * defaults to 0.25% (tickSpacing 2).
 */
export async function createClmmPool(
  conn: Connection,
  keypair: Keypair,
  args: {
    tokenAMint: string;
    tokenBMint: string;
    amountA: string | number;
    amountB: string | number;
    feeTier?: number;
    initialPrice?: string | number;
  },
): Promise<ClmmLpResult> {
  const client = buildClmmClient(conn, keypair);
  const owner = keypair.publicKey;

  const feeBps = args.feeTier ?? DEFAULT_CLMM_FEE_TIER_BPS;
  const tickSpacing = CLMM_FEE_TIER_TICK_SPACING[feeBps];
  if (tickSpacing == null) {
    throw new CookieMcpError(
      `unsupported CLMM fee tier ${feeBps} bps`,
      `use one of: ${Object.keys(CLMM_FEE_TIER_TICK_SPACING).join(", ")}`,
    );
  }

  // Resolve + canonically order the mints (Orca requires mintA < mintB), keeping amounts aligned.
  const x = {
    mint: new PublicKey(args.tokenAMint),
    ui: Number(args.amountA),
    str: args.tokenAMint,
  };
  const y = {
    mint: new PublicKey(args.tokenBMint),
    ui: Number(args.amountB),
    str: args.tokenBMint,
  };
  const [a, b] = Buffer.compare(x.mint.toBuffer(), y.mint.toBuffer()) < 0 ? [x, y] : [y, x];
  const [ma, mb] = await Promise.all([resolveMint(conn, a.mint), resolveMint(conn, b.mint)]);

  // Cap the COOK side (a brand-new token side usually has no price → not capped).
  await capSide(a.str, a.ui);
  await capSide(b.str, b.ui);

  // Initial price = tokenB per tokenA. Prefer the explicit price; else the deposit ratio.
  const price =
    args.initialPrice != null
      ? new Decimal(args.initialPrice.toString())
      : new Decimal(b.ui || 0).div(a.ui || 1);
  if (!price.isFinite() || price.lte(0)) {
    throw new CookieMcpError(
      "cannot determine an initial price",
      "provide `initialPrice`, or non-zero amountA and amountB",
    );
  }
  const initialTick = PriceMath.priceToInitializableTickIndex(
    price,
    ma.decimals,
    mb.decimals,
    tickSpacing,
  );

  const { poolKey, tx: createTx } = await client.createPool(
    WHIRLPOOL_CONFIG_ADDRESS,
    a.mint,
    b.mint,
    tickSpacing,
    initialTick,
    owner,
  );
  await sendBuilder(conn, keypair, createTx, INIT_POOL_CU);

  // Seed a full-range position with the provided amounts.
  const pool = await client.getPool(poolKey);
  await pool.refreshData();
  const data = pool.getData();
  const rawA = new BN(uiToRaw(a.ui, ma.decimals).toString());
  const rawB = new BN(uiToRaw(b.ui, mb.decimals).toString());
  const [tickLower, tickUpper] = TickUtil.getFullRangeTickIndex(tickSpacing);
  const tickInit = await pool.initTickArrayForTicks([tickLower, tickUpper], owner);
  if (tickInit && !tickInit.isEmpty()) {
    await sendBuilder(conn, keypair, tickInit, OPEN_POSITION_CU);
  }
  const slippage = Percentage.fromFraction(DEFAULT_SLIPPAGE_BPS, 10_000);
  const { lowerBound, upperBound } = PriceMath.getSlippageBoundForSqrtPrice(
    data.sqrtPrice,
    slippage,
  );
  const { tx: openTx } = await pool.openPositionWithMetadata(
    tickLower,
    tickUpper,
    { tokenMaxA: rawA, tokenMaxB: rawB, minSqrtPrice: lowerBound[0], maxSqrtPrice: upperBound[0] },
    owner,
    owner,
  );
  const sig = await sendBuilder(conn, keypair, openTx, OPEN_POSITION_CU);
  return result(sig, poolKey.toBase58());
}
