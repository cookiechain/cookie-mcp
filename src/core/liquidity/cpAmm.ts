// Headless Cookiebox DAMM v2 (cp-amm) client. @meteora-ag/cp-amm-sdk's CpAmm hardcodes Meteora's
// mainnet program id, so we Object.assign an anchor Program built from the Cookie cp_amm IDL + program
// id, and derive every PDA against Cookie's program (the SDK's own derive* helpers use mainnet's and
// would break ConstraintSeeds). The SDK, anchor, and web3.js all resolve from this package, so there's
// a single web3.js instance end-to-end (no dual-instance signing hazard).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import anchorPkg, { type Idl, type Program } from "@coral-xyz/anchor";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

import cpAmmIdl from "../../idl/cp_amm.json" with { type: "json" };

const { AnchorProvider, Wallet } = anchorPkg;

export const CP_AMM_PROGRAM_ID = new PublicKey("DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY");

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
