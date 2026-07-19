// The DBC `initialize_virtual_pool_with_spl_token` instruction, hand-encoded from the IDL (no anchor
// dep). A golden-bytes test in dbc.test.ts guards the encoding against accidental edits.
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";

export const DBC_PROGRAM_ID = new PublicKey("DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf");
export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// The launch PoolConfig used for every launch (Cookiebox's 1B-supply config).
export const DBC_LAUNCH_CONFIG = new PublicKey("3yh4ykRE8NKnnXivm3UJjPmqXcbpQAxzJkAsqXZmdGAt");

export const DBC_POOL_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_authority")],
  DBC_PROGRAM_ID,
)[0];
export const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  DBC_PROGRAM_ID,
)[0];

const LAUNCH_DISCRIMINATOR = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79]);

export const DBC_INIT_POOL_CU = 400_000;
export const DBC_TOKEN_DECIMALS = 6;

function maxKey(a: PublicKey, b: PublicKey): Buffer {
  const ba = a.toBuffer();
  const bb = b.toBuffer();
  return Buffer.compare(ba, bb) === 1 ? ba : bb;
}
function minKey(a: PublicKey, b: PublicKey): Buffer {
  const ba = a.toBuffer();
  const bb = b.toBuffer();
  return Buffer.compare(ba, bb) === 1 ? bb : ba;
}

export function deriveDbcPoolAddress(
  config: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      config.toBuffer(),
      maxKey(baseMint, quoteMint),
      minKey(baseMint, quoteMint),
    ],
    DBC_PROGRAM_ID,
  )[0];
}

export function deriveDbcTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
    DBC_PROGRAM_ID,
  )[0];
}

export function deriveDbcMetadataAccount(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  )[0];
}

// Borsh string: u32 LE length + utf8 bytes.
export function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

export function encodeLaunchData(name: string, symbol: string, uri: string): Buffer {
  return Buffer.concat([
    LAUNCH_DISCRIMINATOR,
    borshString(name),
    borshString(symbol),
    borshString(uri),
  ]);
}

export interface LaunchIxParts {
  ix: TransactionInstruction;
  pool: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
}

// `payer` is creator + payer + fee payer (one wallet); `baseMint` is the mint keypair's pubkey;
// `quoteMint` is wCOOK/native. Accounts must be in exact IDL order.
export function buildLaunchIx(args: {
  payer: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): LaunchIxParts {
  const { payer, baseMint, quoteMint, name, symbol, uri } = args;
  const pool = deriveDbcPoolAddress(DBC_LAUNCH_CONFIG, baseMint, quoteMint);
  const baseVault = deriveDbcTokenVault(baseMint, pool);
  const quoteVault = deriveDbcTokenVault(quoteMint, pool);
  const mintMetadata = deriveDbcMetadataAccount(baseMint);

  const keys = [
    { pubkey: DBC_LAUNCH_CONFIG, isSigner: false, isWritable: false }, // config
    { pubkey: DBC_POOL_AUTHORITY, isSigner: false, isWritable: false }, // pool_authority
    { pubkey: payer, isSigner: true, isWritable: false }, // creator
    { pubkey: baseMint, isSigner: true, isWritable: true }, // base_mint
    { pubkey: quoteMint, isSigner: false, isWritable: false }, // quote_mint
    { pubkey: pool, isSigner: false, isWritable: true }, // pool
    { pubkey: baseVault, isSigner: false, isWritable: true }, // base_vault
    { pubkey: quoteVault, isSigner: false, isWritable: true }, // quote_vault
    { pubkey: mintMetadata, isSigner: false, isWritable: true }, // mint_metadata
    { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false }, // metadata_program
    { pubkey: payer, isSigner: true, isWritable: true }, // payer
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_quote_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    { pubkey: DBC_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // event_authority
    { pubkey: DBC_PROGRAM_ID, isSigner: false, isWritable: false }, // program
  ];

  const ix = new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys,
    data: encodeLaunchData(name, symbol, uri),
  });
  return { ix, pool, baseVault, quoteVault };
}
