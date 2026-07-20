// Baked Bazaar — Cookie Chain's NFT marketplace, a Metaplex Auction House fork (program hausS13j…).
//
// The deployed house (`EnsbBy…`) has requires_sign_off=false, has_auctioneer=false, and a NATIVE
// treasury mint (wrapped-SOL / COOK), so every op — list (sell), buy, cancel, make/accept/cancel
// offer — builds and signs entirely client-side with no marketplace co-signer. We hand-encode the
// instructions (standard Anchor sighash discriminators + classic AH account layouts) against the
// Cookie program id rather than pulling the mpl-auction-house SDK (which would derive PDAs against
// mainnet ids — the same fork trap we hit with cp-amm/whirlpool). Every builder below is byte-for-byte
// the same instruction the bakedbazaar.art frontend builds; the golden-bytes tests pin them.
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// --- Program + house constants (verified on-chain 2026-07-20) ------------------------------------
export const AH_PROGRAM = new PublicKey("hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk");
export const AUCTION_HOUSE = new PublicKey("EnsbByCrLDxHLMiZSdWa79SKmHsjQ5AaxXMTzRqpS5Nu");
export const AH_AUTHORITY = new PublicKey("ESg7dvoD2tdaGpdu99sU8aGETkZzxzn9TP78FSLrZvYM");
export const AH_FEE_ACCOUNT = new PublicKey("5uozrzvkbtWCrtVLN6fxCVFE7tzocoojR5gt6Z2ak6Xy");
export const AH_TREASURY = new PublicKey("BB67Nb7jkiDwpiQZYyLDj8qUhVBLfJNwNJ2WCCwixYn8");
// Native treasury mint = wrapped SOL (COOK). Payment/receipt accounts are the wallet itself.
export const AH_TREASURY_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const AH_SELLER_FEE_BPS = 100; // 1% marketplace fee

// Standard Anchor sighash discriminators, sha256("global:<name>")[..8]. Verified in the IDL against
// on-chain txs.
const DISC = {
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  public_buy: [169, 84, 218, 35, 42, 206, 16, 171],
  execute_sale: [37, 74, 217, 157, 79, 49, 35, 6],
  cancel: [232, 219, 223, 41, 219, 236, 220, 190],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;

const PREFIX = Buffer.from("auction_house");
const SIGNER = Buffer.from("signer");
const METADATA = Buffer.from("metadata");

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function disc(name: keyof typeof DISC): Buffer {
  return Buffer.from(DISC[name]);
}
function meta(pk: PublicKey, isSigner: boolean, isWritable: boolean) {
  return { pubkey: pk, isSigner, isWritable };
}

// --- PDAs (classic Metaplex Auction House seeds, derived under AH_PROGRAM) ------------------------
export function metadataPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [METADATA, TOKEN_METADATA_PROGRAM.toBuffer(), nftMint.toBuffer()],
    TOKEN_METADATA_PROGRAM,
  )[0];
}
export function escrowPaymentAccount(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PREFIX, AUCTION_HOUSE.toBuffer(), wallet.toBuffer()],
    AH_PROGRAM,
  );
}
export function programAsSigner(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PREFIX, SIGNER], AH_PROGRAM);
}
// Seller trade state and the private-`buy` buyer trade state (both keyed on a token account + price).
export function tokenTradeState(
  wallet: PublicKey,
  tokenAccount: PublicKey,
  nftMint: PublicKey,
  price: bigint,
  tokenSize: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      PREFIX,
      wallet.toBuffer(),
      AUCTION_HOUSE.toBuffer(),
      tokenAccount.toBuffer(),
      AH_TREASURY_MINT.toBuffer(),
      nftMint.toBuffer(),
      u64LE(price),
      u64LE(tokenSize),
    ],
    AH_PROGRAM,
  );
}
// Public-bid trade state (no token account in the seeds).
export function publicBidTradeState(
  wallet: PublicKey,
  nftMint: PublicKey,
  price: bigint,
  tokenSize: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      PREFIX,
      wallet.toBuffer(),
      AUCTION_HOUSE.toBuffer(),
      AH_TREASURY_MINT.toBuffer(),
      nftMint.toBuffer(),
      u64LE(price),
      u64LE(tokenSize),
    ],
    AH_PROGRAM,
  );
}
export function buyerReceiptTokenAccount(nftMint: PublicKey, buyer: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(nftMint, buyer, true, TOKEN_PROGRAM_ID);
}

export interface Creator {
  address: string;
  verified?: boolean;
  share?: number;
}

// --- Trade-state account decode -------------------------------------------------------------------
// This fork stores a fully-serialized trade state (unlike classic AH's 1-byte bump PDA), so any
// listing / offer account describes itself. Offsets verified on-chain + against the frontend.
const TS = {
  auctionHouse: 8,
  buyer: 40,
  tokenMint: 72,
  tokenAccount: 104,
  treasuryMint: 136,
  tokenSize: 168,
  buyPrice: 176,
  seller: 184,
} as const;
export const TRADE_STATE_MIN_LEN = TS.seller + 32;

export interface TradeState {
  auctionHouse: string;
  buyer: string;
  tokenMint: string;
  tokenAccount: string;
  treasuryMint: string;
  tokenSize: bigint;
  buyPrice: bigint;
  seller: string;
}

export function decodeTradeState(data: Buffer): TradeState | null {
  if (data.length < TRADE_STATE_MIN_LEN) return null;
  const pk = (off: number) => new PublicKey(data.subarray(off, off + 32)).toBase58();
  return {
    auctionHouse: pk(TS.auctionHouse),
    buyer: pk(TS.buyer),
    tokenMint: pk(TS.tokenMint),
    tokenAccount: pk(TS.tokenAccount),
    treasuryMint: pk(TS.treasuryMint),
    tokenSize: data.readBigUInt64LE(TS.tokenSize),
    buyPrice: data.readBigUInt64LE(TS.buyPrice),
    seller: pk(TS.seller),
  };
}

// --- Instruction builders (byte-exact vs the bakedbazaar.art frontend) ---------------------------
const ix = (keys: ReturnType<typeof meta>[], data: Buffer) =>
  new TransactionInstruction({ programId: AH_PROGRAM, keys, data });

/** `sell` — list an NFT you own at `price`. Seller signs. */
export function buildSellIx(args: {
  seller: PublicKey;
  sellerTokenAccount: PublicKey;
  nftMint: PublicKey;
  price: bigint;
  tokenSize?: bigint;
}): TransactionInstruction {
  const tokenSize = args.tokenSize ?? 1n;
  const metadata = metadataPda(args.nftMint);
  const [tradeState, tradeBump] = tokenTradeState(
    args.seller,
    args.sellerTokenAccount,
    args.nftMint,
    args.price,
    tokenSize,
  );
  const [freeTradeState, freeBump] = tokenTradeState(
    args.seller,
    args.sellerTokenAccount,
    args.nftMint,
    0n,
    tokenSize,
  );
  const [progSigner, progSignerBump] = programAsSigner();
  const data = Buffer.concat([
    disc("sell"),
    Buffer.from([tradeBump, freeBump, progSignerBump]),
    u64LE(args.price),
    u64LE(tokenSize),
  ]);
  return ix(
    [
      meta(args.seller, true, false),
      meta(args.sellerTokenAccount, false, true),
      meta(metadata, false, false),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(tradeState, false, true),
      meta(freeTradeState, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(progSigner, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data,
  );
}

/** `buy` — a private bid tied to a specific seller token account (used for instant buys). */
export function buildBuyIx(args: {
  buyer: PublicKey;
  sellerTokenAccount: PublicKey;
  nftMint: PublicKey;
  price: bigint;
  tokenSize?: bigint;
}): TransactionInstruction {
  const tokenSize = args.tokenSize ?? 1n;
  const metadata = metadataPda(args.nftMint);
  const [escrow, escrowBump] = escrowPaymentAccount(args.buyer);
  const [tradeState, tradeBump] = tokenTradeState(
    args.buyer,
    args.sellerTokenAccount,
    args.nftMint,
    args.price,
    tokenSize,
  );
  const data = Buffer.concat([
    disc("buy"),
    Buffer.from([tradeBump, escrowBump]),
    u64LE(args.price),
    u64LE(tokenSize),
  ]);
  return ix(
    [
      meta(args.buyer, true, false),
      meta(args.buyer, false, true), // payment account (native → wallet)
      meta(args.buyer, false, false), // transfer authority (native → wallet)
      meta(AH_TREASURY_MINT, false, false),
      meta(args.sellerTokenAccount, false, false),
      meta(metadata, false, false),
      meta(escrow, false, true),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(tradeState, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data,
  );
}

/** `public_buy` — a public bid/offer on an NFT (any current holder can accept). */
export function buildPublicBuyIx(args: {
  buyer: PublicKey;
  nftMint: PublicKey;
  price: bigint;
  tokenSize?: bigint;
}): TransactionInstruction {
  const tokenSize = args.tokenSize ?? 1n;
  const metadata = metadataPda(args.nftMint);
  const receiptAta = buyerReceiptTokenAccount(args.nftMint, args.buyer);
  const [escrow, escrowBump] = escrowPaymentAccount(args.buyer);
  const [tradeState, tradeBump] = publicBidTradeState(
    args.buyer,
    args.nftMint,
    args.price,
    tokenSize,
  );
  const data = Buffer.concat([
    disc("public_buy"),
    Buffer.from([tradeBump, escrowBump]),
    u64LE(args.price),
    u64LE(tokenSize),
  ]);
  return ix(
    [
      meta(args.buyer, true, false),
      meta(args.buyer, false, true), // payment account (native → wallet)
      meta(args.buyer, false, false), // transfer authority (native → wallet)
      meta(AH_TREASURY_MINT, false, false),
      meta(receiptAta, false, false),
      meta(metadata, false, false),
      meta(escrow, false, true),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(tradeState, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data,
  );
}

/** `execute_sale` — match a buyer + seller trade state; transfers the NFT and pays out (net fees +
 * royalties). Anyone can call it; the caller pays fees. `buyerSide` picks which bid to settle. */
export function buildExecuteSaleIx(args: {
  buyer: PublicKey;
  seller: PublicKey;
  sellerTokenAccount: PublicKey;
  nftMint: PublicKey;
  price: bigint;
  creators: Creator[];
  buyerSide: "buy" | "publicBuy";
  tokenSize?: bigint;
}): TransactionInstruction {
  const tokenSize = args.tokenSize ?? 1n;
  const metadata = metadataPda(args.nftMint);
  const [escrow, escrowBump] = escrowPaymentAccount(args.buyer);
  const [progSigner, progSignerBump] = programAsSigner();
  const [buyerTradeState] =
    args.buyerSide === "publicBuy"
      ? publicBidTradeState(args.buyer, args.nftMint, args.price, tokenSize)
      : tokenTradeState(args.buyer, args.sellerTokenAccount, args.nftMint, args.price, tokenSize);
  const [sellerTradeState] = tokenTradeState(
    args.seller,
    args.sellerTokenAccount,
    args.nftMint,
    args.price,
    tokenSize,
  );
  const [freeTradeState, freeBump] = tokenTradeState(
    args.seller,
    args.sellerTokenAccount,
    args.nftMint,
    0n,
    tokenSize,
  );
  const buyerReceipt = buyerReceiptTokenAccount(args.nftMint, args.buyer);
  const data = Buffer.concat([
    disc("execute_sale"),
    Buffer.from([escrowBump, freeBump, progSignerBump]),
    u64LE(args.price),
    u64LE(tokenSize),
  ]);
  const keys = [
    meta(args.buyer, false, true),
    meta(args.seller, false, true),
    meta(args.sellerTokenAccount, false, true),
    meta(args.nftMint, false, false),
    meta(metadata, false, false),
    meta(AH_TREASURY_MINT, false, false),
    meta(escrow, false, true),
    meta(args.seller, false, true), // seller payment receipt (native → wallet)
    meta(buyerReceipt, false, true),
    meta(AH_AUTHORITY, false, false),
    meta(AUCTION_HOUSE, false, false),
    meta(AH_FEE_ACCOUNT, false, true),
    meta(AH_TREASURY, false, true),
    meta(buyerTradeState, false, true),
    meta(sellerTradeState, false, true),
    meta(freeTradeState, false, true),
    meta(TOKEN_PROGRAM_ID, false, false),
    meta(SystemProgram.programId, false, false),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    meta(progSigner, false, false),
    meta(SYSVAR_RENT_PUBKEY, false, false),
  ];
  // Royalty recipients from the NFT metadata, appended as writable remaining accounts.
  for (const c of args.creators) keys.push(meta(new PublicKey(c.address), false, true));
  return ix(keys, data);
}

/** `cancel` — cancel your own listing (`sell` side) or offer (`publicBuy` side). */
export function buildCancelIx(args: {
  wallet: PublicKey;
  tokenAccount: PublicKey;
  nftMint: PublicKey;
  price: bigint;
  side: "sell" | "publicBuy";
  tokenSize?: bigint;
}): TransactionInstruction {
  const tokenSize = args.tokenSize ?? 1n;
  const [tradeState] =
    args.side === "publicBuy"
      ? publicBidTradeState(args.wallet, args.nftMint, args.price, tokenSize)
      : tokenTradeState(args.wallet, args.tokenAccount, args.nftMint, args.price, tokenSize);
  const data = Buffer.concat([disc("cancel"), u64LE(args.price), u64LE(tokenSize)]);
  return ix(
    [
      meta(args.wallet, true, true),
      meta(args.tokenAccount, false, true),
      meta(args.nftMint, false, false),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(tradeState, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data,
  );
}

/** `deposit` — fund the buyer's escrow with `amount` lamports (native). */
export function buildDepositIx(args: {
  wallet: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const [escrow, escrowBump] = escrowPaymentAccount(args.wallet);
  const data = Buffer.concat([disc("deposit"), Buffer.from([escrowBump]), u64LE(args.amount)]);
  return ix(
    [
      meta(args.wallet, true, false),
      meta(args.wallet, false, true), // payment account (native → wallet)
      meta(args.wallet, false, false), // transfer authority (native → wallet)
      meta(escrow, false, true),
      meta(AH_TREASURY_MINT, false, false),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data,
  );
}

/** `withdraw` — pull `amount` lamports back from the buyer's escrow to the wallet. */
export function buildWithdrawIx(args: {
  wallet: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const [escrow, escrowBump] = escrowPaymentAccount(args.wallet);
  const data = Buffer.concat([disc("withdraw"), Buffer.from([escrowBump]), u64LE(args.amount)]);
  return ix(
    [
      meta(args.wallet, true, false),
      meta(args.wallet, false, true), // payment account (native → wallet)
      meta(escrow, false, true),
      meta(AH_TREASURY_MINT, false, false),
      meta(AH_AUTHORITY, false, false),
      meta(AUCTION_HOUSE, false, false),
      meta(AH_FEE_ACCOUNT, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(SystemProgram.programId, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      meta(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data,
  );
}
