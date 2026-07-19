// claim_creator_fees — claim the creator trading fees a Cookiebox DBC token has accrued for its
// launcher. The DBC `claim_creator_trading_fee` ix takes all accounts explicitly (no mainnet-PDA
// hazard), so we just decode the pool state via an anchor Program built from the Cookie DBC IDL and
// pass the pool's own vaults / mints. Non-custodial; requires the launch wallet.
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import anchorPkg, { type Idl, type Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";

import dbcIdl from "../../idl/dynamic_bonding_curve.json" with { type: "json" };
import {
  COOK_MINT,
  COOK_DECIMALS,
  explorerTxUrl,
  explorerTokenUrl,
  explorerAddressUrl,
} from "../config";
import { CookieMcpError } from "../errors";
import { getConnection } from "../rpc";
import { requireWallet } from "../wallet";
import { rawToUi } from "../format";
import {
  DBC_PROGRAM_ID,
  DBC_LAUNCH_CONFIG,
  DBC_POOL_AUTHORITY,
  DBC_EVENT_AUTHORITY,
  DBC_TOKEN_DECIMALS,
  deriveDbcPoolAddress,
} from "./dbc";

const { AnchorProvider, Wallet } = anchorPkg;
const DBC_CLAIM_CREATOR_FEE_CU = 200_000;

// The provider wallet is a throwaway keypair — we build the tx and sign it ourselves.
function buildDbcProgram(connection: Connection): Program {
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  return new anchorPkg.Program(
    { ...(dbcIdl as Idl), address: DBC_PROGRAM_ID.toBase58() },
    provider,
  ) as unknown as Program;
}

interface DbcPoolState {
  creator: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  creatorBaseFee: BN;
  creatorQuoteFee: BN;
}

export interface ClaimCreatorFeesResult {
  signature: string;
  mint: string;
  pool: string;
  claimed: { base: string; quote: string };
  explorerUrl: string;
  links: { explorerTx: string; token: string; pool: string };
}

export async function claimCreatorFees(args: { mint: string }): Promise<ClaimCreatorFeesResult> {
  const { keypair } = requireWallet();
  const owner = keypair.publicKey;
  const conn = getConnection();

  let baseMint: PublicKey;
  try {
    baseMint = new PublicKey(args.mint);
  } catch {
    throw new CookieMcpError(
      `invalid mint address: ${args.mint}`,
      "pass the base mint of a token you launched with deploy_token",
    );
  }
  const quoteMint = new PublicKey(COOK_MINT); // Cookiebox DBC launches quote in wCOOK.
  const pool = deriveDbcPoolAddress(DBC_LAUNCH_CONFIG, baseMint, quoteMint);

  const program = buildDbcProgram(conn);
  const poolAccount = (
    program.account as Record<string, { fetchNullable(pk: PublicKey): Promise<unknown> }>
  ).virtualPool;
  const state = (await poolAccount.fetchNullable(pool)) as DbcPoolState | null;
  if (!state) {
    throw new CookieMcpError(
      `no Cookiebox DBC pool for mint ${baseMint.toBase58()}`,
      "pass the mint of a token launched via deploy_token",
    );
  }
  if (!state.creator.equals(owner)) {
    throw new CookieMcpError(
      "you are not the creator of this token",
      "only the wallet that launched the token can claim its creator fees",
    );
  }

  const baseFee = new BN(state.creatorBaseFee.toString());
  const quoteFee = new BN(state.creatorQuoteFee.toString());
  if (baseFee.isZero() && quoteFee.isZero()) {
    throw new CookieMcpError(
      "no creator fees to claim yet",
      "creator fees accrue as your token trades on the bonding curve — try again after some volume",
    );
  }

  const baseAta = getAssociatedTokenAddressSync(baseMint, owner, true, TOKEN_PROGRAM_ID);
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, owner, true, TOKEN_PROGRAM_ID);
  const pre: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(owner, baseAta, owner, baseMint),
    createAssociatedTokenAccountIdempotentInstruction(owner, quoteAta, owner, quoteMint),
  ];
  const post: TransactionInstruction[] = [];
  // Return the claimed wrapped-native fee as native COOK.
  if (quoteMint.equals(NATIVE_MINT))
    post.push(createCloseAccountInstruction(quoteAta, owner, owner));

  const claimIx = await program.methods
    .claimCreatorTradingFee(baseFee, quoteFee)
    .accountsPartial({
      poolAuthority: DBC_POOL_AUTHORITY,
      pool,
      tokenAAccount: baseAta,
      tokenBAccount: quoteAta,
      baseVault: state.baseVault,
      quoteVault: state.quoteVault,
      baseMint,
      quoteMint,
      creator: owner,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      eventAuthority: DBC_EVENT_AUTHORITY,
    })
    .instruction();

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: DBC_CLAIM_CREATOR_FEE_CU }),
    ...pre,
    claimIx,
    ...post,
  );

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const blob = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    if (/BlockhashNotFound|blockhash/i.test(blob)) {
      throw new CookieMcpError(
        "claim simulation failed: blockhash not found",
        "Cookie Chain finalization may be stalled — check chain_health; retry",
      );
    }
    throw new CookieMcpError(
      `claim simulation failed${logs.length ? `: ${logs.slice(-2).join(" | ")}` : ""}`,
      "check that you are the token's creator and that fees are still claimable",
    );
  }

  tx.sign(keypair);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  return {
    signature,
    mint: baseMint.toBase58(),
    pool: pool.toBase58(),
    claimed: {
      base: rawToUi(BigInt(baseFee.toString()), DBC_TOKEN_DECIMALS),
      quote: rawToUi(BigInt(quoteFee.toString()), COOK_DECIMALS),
    },
    explorerUrl: explorerTxUrl(signature),
    links: {
      explorerTx: explorerTxUrl(signature),
      token: explorerTokenUrl(baseMint.toBase58()),
      pool: explorerAddressUrl(pool.toBase58()),
    },
  };
}
