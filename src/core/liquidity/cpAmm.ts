// Headless Cookiebox DAMM v2 (cp-amm) client. @meteora-ag/cp-amm-sdk's CpAmm hardcodes Meteora's
// mainnet program id, so we Object.assign an anchor Program built from the Cookie cp_amm IDL + program
// id, and derive every PDA against Cookie's program (the SDK's own derive* helpers use mainnet's and
// would break ConstraintSeeds). The SDK, anchor, and web3.js all resolve from this package, so there's
// a single web3.js instance end-to-end (no dual-instance signing hazard).
//
// The SDK's *explicit-account* methods (addLiquidity/removeLiquidity/permanentLockPosition) pass PDAs
// straight through, so they work on the fork with Cookie-derived accounts. But its *position-creating*
// paths (createPositionAndAddLiquidity, createPool) derive position/nft/vault PDAs internally with the
// mainnet program id → ConstraintSeeds (0x7d6). We therefore build create_position and initialize_pool
// ourselves via the Cookie anchor Program with Cookie-derived PDAs (below).
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import anchorPkg, { type Idl, type Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  AccountLayout,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";

import cpAmmIdl from "../../idl/cp_amm.json" with { type: "json" };

const { AnchorProvider, Wallet } = anchorPkg;

export const CP_AMM_PROGRAM_ID = new PublicKey("DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY");

// Default permissionless PoolConfig for create_pool (quote-only fee mode). Override per call if needed.
export const DAMM_CREATE_CONFIG = new PublicKey("HrR3btHfwZ13ceqYD7fUEPfX7Rk6M4i7EgE88abUu5Jc");

const S = {
  poolAuthority: Buffer.from("pool_authority"),
  pool: Buffer.from("pool"),
  position: Buffer.from("position"),
  positionNftAccount: Buffer.from("position_nft_account"),
  tokenVault: Buffer.from("token_vault"),
};

export function derivePoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([S.poolAuthority], CP_AMM_PROGRAM_ID)[0];
}
function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) >= 0 ? a : b;
}
function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? a : b;
}
export function derivePoolAddress(
  config: PublicKey,
  tokenA: PublicKey,
  tokenB: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      S.pool,
      config.toBuffer(),
      maxKey(tokenA, tokenB).toBuffer(),
      minKey(tokenA, tokenB).toBuffer(),
    ],
    CP_AMM_PROGRAM_ID,
  )[0];
}
export function derivePositionAddress(positionNftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [S.position, positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}
export function derivePositionNftAccount(positionNftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [S.positionNftAccount, positionNftMint.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}
export function deriveTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [S.tokenVault, mint.toBuffer(), pool.toBuffer()],
    CP_AMM_PROGRAM_ID,
  )[0];
}

export interface CpAmmDeps {
  cpAmm: CpAmm;
  program: Program;
  poolAuthority: PublicKey;
}

// The provider wallet is a throwaway keypair — we build txs and sign them ourselves.
export function buildCpAmmDeps(connection: Connection): CpAmmDeps {
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  const program = new anchorPkg.Program(
    { ...(cpAmmIdl as Idl), address: CP_AMM_PROGRAM_ID.toBase58() },
    provider,
  ) as unknown as Program;
  const poolAuthority = derivePoolAuthority();
  const cpAmm = new CpAmm(connection);
  Object.assign(cpAmm, { _program: program, poolAuthority });
  return { cpAmm, program, poolAuthority };
}

// --- Cookie-correct instruction builders (bypass the SDK's mainnet-derived PDAs) ------------------

/** owner's ATA for a mint + an idempotent create ix (safe if it already exists). */
function ataWithCreateIx(
  mint: PublicKey,
  owner: PublicKey,
  program: PublicKey,
): { ata: PublicKey; ix: TransactionInstruction } {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
  const ix = createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, program);
  return { ata, ix };
}

/** Fund a wrapped-SOL ATA: transfer lamports in, then SyncNative. */
function wrapNativeIxs(
  owner: PublicKey,
  ata: PublicKey,
  lamports: bigint,
): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata),
  ];
}

interface AddLiquidityBuild {
  deps: CpAmmDeps;
  owner: PublicKey;
  pool: PublicKey;
  positionNft: PublicKey; // the fresh position-NFT mint (also a signer on the tx)
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  liquidityDelta: BN;
  maxAmountTokenA: BN;
  maxAmountTokenB: BN;
  tokenAAmountThreshold?: BN;
  tokenBAmountThreshold?: BN;
}

/**
 * Build a create-position + add-liquidity Transaction against the Cookie program. Mirrors the SDK's
 * createPositionAndAddLiquidity but derives position / positionNftAccount / vaults with Cookie's
 * program id, so the on-chain ConstraintSeeds checks pass on the fork.
 */
export async function buildCreatePositionAndAddLiquidityTx(
  p: AddLiquidityBuild,
): Promise<Transaction> {
  const { program } = p.deps;
  const position = derivePositionAddress(p.positionNft);
  const positionNftAccount = derivePositionNftAccount(p.positionNft);
  const tokenAVault = deriveTokenVault(p.tokenAMint, p.pool);
  const tokenBVault = deriveTokenVault(p.tokenBMint, p.pool);

  const aTa = ataWithCreateIx(p.tokenAMint, p.owner, p.tokenAProgram);
  const bTa = ataWithCreateIx(p.tokenBMint, p.owner, p.tokenBProgram);

  const pre: TransactionInstruction[] = [aTa.ix, bTa.ix];
  const post: TransactionInstruction[] = [];
  if (p.tokenAMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(p.owner, aTa.ata, BigInt(p.maxAmountTokenA.toString())));
  }
  if (p.tokenBMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(p.owner, bTa.ata, BigInt(p.maxAmountTokenB.toString())));
  }
  if (p.tokenAMint.equals(NATIVE_MINT) || p.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, p.owner, true);
    post.push(createCloseAccountInstruction(wsol, p.owner, p.owner));
  }

  const createPositionIx = await program.methods
    .createPosition()
    .accountsPartial({
      owner: p.owner,
      positionNftMint: p.positionNft,
      poolAuthority: p.deps.poolAuthority,
      positionNftAccount,
      pool: p.pool,
      position,
      payer: p.owner,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const addLiquidityIx = await program.methods
    .addLiquidity({
      liquidityDelta: p.liquidityDelta,
      tokenAAmountThreshold: p.tokenAAmountThreshold ?? new BN(0),
      tokenBAmountThreshold: p.tokenBAmountThreshold ?? new BN(0),
    })
    .accountsPartial({
      pool: p.pool,
      position,
      tokenAAccount: aTa.ata,
      tokenBAccount: bTa.ata,
      tokenAVault,
      tokenBVault,
      tokenAMint: p.tokenAMint,
      tokenBMint: p.tokenBMint,
      positionNftAccount,
      owner: p.owner,
      tokenAProgram: p.tokenAProgram,
      tokenBProgram: p.tokenBProgram,
    })
    .instruction();

  return new Transaction().add(createPositionIx, ...pre, addLiquidityIx, ...post);
}

interface CreatePoolBuild {
  deps: CpAmmDeps;
  owner: PublicKey;
  config: PublicKey;
  positionNft: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  initSqrtPrice: BN;
  liquidityDelta: BN;
  tokenAAmount: BN;
  tokenBAmount: BN;
}

/**
 * Build an initialize_pool Transaction against the Cookie program (Cookie-derived pool / position /
 * vault PDAs). Mirrors the SDK's createPool. Token badges are omitted — plain SPL/Token-2022 mints on
 * Cookie have none, so no remaining accounts are needed.
 */
export async function buildCreatePoolTx(p: CreatePoolBuild): Promise<Transaction> {
  const { program } = p.deps;
  const pool = derivePoolAddress(p.config, p.tokenAMint, p.tokenBMint);
  const position = derivePositionAddress(p.positionNft);
  const positionNftAccount = derivePositionNftAccount(p.positionNft);
  const tokenAVault = deriveTokenVault(p.tokenAMint, pool);
  const tokenBVault = deriveTokenVault(p.tokenBMint, pool);

  const aTa = ataWithCreateIx(p.tokenAMint, p.owner, p.tokenAProgram);
  const bTa = ataWithCreateIx(p.tokenBMint, p.owner, p.tokenBProgram);
  const pre: TransactionInstruction[] = [aTa.ix, bTa.ix];
  const post: TransactionInstruction[] = [];
  if (p.tokenAMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(p.owner, aTa.ata, BigInt(p.tokenAAmount.toString())));
  }
  if (p.tokenBMint.equals(NATIVE_MINT)) {
    pre.push(...wrapNativeIxs(p.owner, bTa.ata, BigInt(p.tokenBAmount.toString())));
  }
  if (p.tokenAMint.equals(NATIVE_MINT) || p.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, p.owner, true);
    post.push(createCloseAccountInstruction(wsol, p.owner, p.owner));
  }

  const initPoolIx = await program.methods
    .initializePool({
      liquidity: p.liquidityDelta,
      sqrtPrice: p.initSqrtPrice,
      activationPoint: null,
    })
    .accountsPartial({
      creator: p.owner,
      positionNftAccount,
      positionNftMint: p.positionNft,
      payer: p.owner,
      config: p.config,
      poolAuthority: p.deps.poolAuthority,
      pool,
      position,
      tokenAMint: p.tokenAMint,
      tokenBMint: p.tokenBMint,
      tokenAVault,
      tokenBVault,
      payerTokenA: aTa.ata,
      payerTokenB: bTa.ata,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenAProgram: p.tokenAProgram,
      tokenBProgram: p.tokenBProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return new Transaction().add(...pre, initPoolIx, ...post);
}

interface RemoveLiquidityBuild {
  deps: CpAmmDeps;
  owner: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  /** null → remove ALL liquidity (uses remove_all_liquidity). */
  liquidityDelta: BN | null;
}

/**
 * Build a remove-liquidity Transaction via the Cookie anchor Program directly (mirrors cookiebox's
 * proven flow). The SDK's CpAmm.removeLiquidity wrapper mis-validates on the fork; building the ix
 * ourselves with Cookie-derived accounts avoids that. Min-out thresholds are 0 (caller may tighten).
 */
export async function buildRemoveLiquidityTx(p: RemoveLiquidityBuild): Promise<Transaction> {
  const { program } = p.deps;
  const aTa = ataWithCreateIx(p.tokenAMint, p.owner, p.tokenAProgram);
  const bTa = ataWithCreateIx(p.tokenBMint, p.owner, p.tokenBProgram);
  const pre: TransactionInstruction[] = [aTa.ix, bTa.ix];
  const post: TransactionInstruction[] = [];
  // Return native COOK (not wrapped) by closing the wSOL ATA after the withdrawal lands.
  if (p.tokenAMint.equals(NATIVE_MINT) || p.tokenBMint.equals(NATIVE_MINT)) {
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, p.owner, true);
    post.push(createCloseAccountInstruction(wsol, p.owner, p.owner));
  }

  const accounts = {
    poolAuthority: p.deps.poolAuthority,
    pool: p.pool,
    position: p.position,
    tokenAAccount: aTa.ata,
    tokenBAccount: bTa.ata,
    tokenAVault: p.tokenAVault,
    tokenBVault: p.tokenBVault,
    tokenAMint: p.tokenAMint,
    tokenBMint: p.tokenBMint,
    positionNftAccount: p.positionNftAccount,
    owner: p.owner,
    tokenAProgram: p.tokenAProgram,
    tokenBProgram: p.tokenBProgram,
  };

  const ix =
    p.liquidityDelta === null
      ? await program.methods
          .removeAllLiquidity(new BN(0), new BN(0))
          .accountsPartial(accounts)
          .instruction()
      : await program.methods
          .removeLiquidity({
            liquidityDelta: p.liquidityDelta,
            tokenAAmountThreshold: new BN(0),
            tokenBAmountThreshold: new BN(0),
          })
          .accountsPartial(accounts)
          .instruction();

  return new Transaction().add(...pre, ix, ...post);
}

/** Build a permanent-lock Transaction for a position's unlocked liquidity, via the Cookie Program. */
export async function buildLockPositionTx(p: {
  deps: CpAmmDeps;
  owner: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  unlockedLiquidity: BN;
}): Promise<Transaction> {
  const ix = await p.deps.program.methods
    .permanentLockPosition(p.unlockedLiquidity)
    .accountsPartial({
      pool: p.pool,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      owner: p.owner,
    })
    .instruction();
  return new Transaction().add(ix);
}

export interface UserPosition {
  positionNftAccount: PublicKey;
  position: PublicKey;
  positionState: {
    pool: PublicKey;
    unlockedLiquidity: BN;
    permanentLockedLiquidity: BN;
    vestedLiquidity: BN;
  };
}

/**
 * Find a wallet's cp-amm positions, optionally filtered to one pool, sorted by total liquidity desc.
 * Reimplements the SDK's getPositionsByUser with Cookie's derivePositionAddress (the SDK derives the
 * position PDA with the mainnet program id, so its finder returns nothing on the fork).
 */
export async function getUserPositions(
  deps: CpAmmDeps,
  connection: Connection,
  owner: PublicKey,
  pool?: PublicKey,
): Promise<UserPosition[]> {
  const tokenAccounts = await connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID,
  });
  const nftAccounts: { positionNft: PublicKey; positionNftAccount: PublicKey }[] = [];
  for (const { account, pubkey } of tokenAccounts.value) {
    const decoded = AccountLayout.decode(account.data);
    if (decoded.amount === 1n) {
      nftAccounts.push({ positionNft: new PublicKey(decoded.mint), positionNftAccount: pubkey });
    }
  }
  if (nftAccounts.length === 0) return [];

  const positionAddresses = nftAccounts.map((a) => derivePositionAddress(a.positionNft));
  // `program` is typed on the generic Idl, so its account namespace isn't statically known.
  const positionAccount = (
    deps.program.account as Record<string, { fetchMultiple(a: PublicKey[]): Promise<unknown[]> }>
  ).position;
  const states = (await positionAccount.fetchMultiple(positionAddresses)) as (
    UserPosition["positionState"] | null
  )[];

  const result: UserPosition[] = [];
  nftAccounts.forEach((a, i) => {
    const st = states[i];
    if (!st) return; // not a cp-amm position NFT (some other Token-2022 NFT)
    if (pool && !st.pool.equals(pool)) return;
    result.push({
      positionNftAccount: a.positionNftAccount,
      position: positionAddresses[i]!,
      positionState: st,
    });
  });
  const total = (p: UserPosition) =>
    p.positionState.vestedLiquidity
      .add(p.positionState.permanentLockedLiquidity)
      .add(p.positionState.unlockedLiquidity);
  result.sort((x, y) => total(y).cmp(total(x)));
  return result;
}
