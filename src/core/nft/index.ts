// Baked Bazaar NFT marketplace — high-level actions + reads. Reads come from the bazaar indexer
// (bazaar.ts); every write builds a Metaplex Auction House tx (auctionHouse.ts), simulates, signs
// locally, sends over our RPC, confirms, and tells the indexer. Non-custodial; the COOK-spending
// tools (buy_nft, make_offer) honor the per-trade spend cap.
import {
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import { COOK_DECIMALS, COOK_SYMBOL, explorerTxUrl } from "../config";
import { CookieMcpError } from "../errors";
import { rawToUi, uiToRaw, shortAddr } from "../format";
import { getConnection } from "../rpc";
import { requireWallet, ownPublicKey, assertWithinSpendCap } from "../wallet";
import { signSendConfirm } from "../liquidity/send";
import {
  AH_SELLER_FEE_BPS,
  escrowPaymentAccount,
  metadataPda,
  buildSellIx,
  buildBuyIx,
  buildPublicBuyIx,
  buildExecuteSaleIx,
  buildCancelIx,
  buildDepositIx,
  buildWithdrawIx,
  type Creator,
} from "./auctionHouse";
import {
  fetchListings,
  fetchNft,
  fetchUserNfts,
  fetchOffersBy,
  fetchOffersReceived,
  fetchStats,
  fetchCollectionStats,
  logTransaction,
  type BazaarListing,
  type BazaarOffer,
} from "./bazaar";

// --- helpers -------------------------------------------------------------------------------------

function cookUi(lamports: string | bigint): string {
  return rawToUi(lamports, COOK_DECIMALS);
}
function priceCook(lamports: string | bigint): number {
  return Number(cookUi(lamports));
}
function listingUrl(mint: string): string {
  return `https://bakedbazaar.art/nft/${mint}`;
}

/** The owner's associated token account for an NFT (classic SPL Token, as the marketplace uses). */
function nftTokenAccount(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
}

/** Escrow balance (native lamports) the wallet already has deposited with the auction house. */
async function escrowBalance(conn: Connection, wallet: PublicKey): Promise<bigint> {
  const [escrow] = escrowPaymentAccount(wallet);
  const bal = await conn.getBalance(escrow, "confirmed");
  return BigInt(bal);
}

/** A deposit ix for the shortfall between the escrow balance and `needed`, or null if already funded. */
async function fundEscrowIx(
  conn: Connection,
  wallet: PublicKey,
  needed: bigint,
): Promise<TransactionInstruction | null> {
  const have = await escrowBalance(conn, wallet);
  if (have >= needed) return null;
  return buildDepositIx({ wallet, amount: needed - have });
}

// The Auction House pays royalties to the NFT's metadata creators (passed as remaining accounts in
// execute_sale). Prefer the indexer's creators; fall back to decoding the on-chain metadata so the
// account set is always exact.
async function resolveCreators(
  conn: Connection,
  mint: PublicKey,
  fromApi?: Creator[],
): Promise<Creator[]> {
  if (fromApi && fromApi.length) return fromApi;
  const info = await conn.getAccountInfo(metadataPda(mint), "confirmed");
  if (!info?.data) return [];
  return decodeMetadataCreators(info.data);
}

// Metaplex Token Metadata is borsh (not Anchor): key(1) + updateAuthority(32) + mint(32) +
// name(4+len) + symbol(4+len) + uri(4+len) + sellerFee(2) + creators(option u8; if 1: u32 count then
// {pubkey(32), verified(1), share(1)} each).
export function decodeMetadataCreators(data: Buffer): Creator[] {
  try {
    let i = 1 + 32 + 32;
    for (let f = 0; f < 3; f++) {
      const len = data.readUInt32LE(i);
      i += 4 + len;
    }
    i += 2; // seller_fee_basis_points
    const hasCreators = data[i] === 1;
    i += 1;
    if (!hasCreators) return [];
    const count = data.readUInt32LE(i);
    i += 4;
    if (count > 5) return [];
    const creators: Creator[] = [];
    for (let c = 0; c < count; c++) {
      const address = new PublicKey(data.subarray(i, i + 32)).toBase58();
      const verified = data[i + 32] === 1;
      const share = data[i + 33];
      creators.push({ address, verified, share });
      i += 34;
    }
    return creators;
  } catch {
    return [];
  }
}

// --- reads ---------------------------------------------------------------------------------------

export interface NftListingView {
  mint: string;
  name?: string;
  symbol?: string;
  price: string; // COOK
  priceLamports: string;
  seller: string;
  image?: string;
  collection?: string;
  listing: string; // seller trade state pubkey
  url: string;
}

function toListingView(l: BazaarListing): NftListingView {
  return {
    mint: l.nftMint,
    name: l.metadata?.name,
    symbol: l.metadata?.symbol,
    price: cookUi(l.price),
    priceLamports: l.price,
    seller: l.seller,
    image: l.metadata?.image,
    collection: l.metadata?.collection?.key,
    listing: l.publicKey,
    url: listingUrl(l.nftMint),
  };
}

/** Active listings, newest-first by default; filterable by collection symbol/key or seller. */
export async function getNftListings(args: {
  collection?: string;
  seller?: string;
  sort?: "price" | "recent";
  limit?: number;
}): Promise<{ count: number; listings: NftListingView[] }> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  let listings = (await fetchListings()).filter((l) => (l.status ?? "").toLowerCase() === "active");
  if (args.seller) listings = listings.filter((l) => l.seller === args.seller);
  if (args.collection) {
    const c = args.collection;
    listings = listings.filter(
      (l) => l.metadata?.collection?.key === c || l.metadata?.symbol === c,
    );
  }
  if (args.sort === "price") {
    listings.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1));
  } else {
    listings.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  return { count: listings.length, listings: listings.slice(0, limit).map(toListingView) };
}

/** Full detail for one NFT: metadata, current listing/price, best offer, collection floor. */
export async function getNft(mint: string): Promise<unknown> {
  const nft = await fetchNft(mint);
  if (!nft) {
    throw new CookieMcpError(
      `NFT ${shortAddr(mint)} not found on Baked Bazaar`,
      "check the mint address; the marketplace indexes Cookie Chain NFTs",
    );
  }
  return {
    mint: nft.mint,
    metadata: nft.metadata,
    listed: !!nft.listing && (nft.listing.status ?? "").toLowerCase() === "active",
    listing: nft.listing
      ? {
          price: cookUi(nft.listing.price),
          priceLamports: nft.listing.price,
          seller: nft.listing.seller,
          sellerTokenAccount: nft.listing.sellerTokenAccount,
          tradeState: nft.listing.publicKey,
        }
      : null,
    topOffer: nft.topOffer
      ? {
          price: cookUi(nft.topOffer.price),
          buyer: nft.topOffer.buyer,
          tradeState: nft.topOffer.tradeState,
        }
      : null,
    floorPrice: nft.floorPrice ? cookUi(nft.floorPrice) : null,
    collectionListings: nft.collectionListings,
    url: listingUrl(nft.mint),
  };
}

/** NFTs held by a wallet (default the configured wallet), with any active listing. */
export async function getWalletNfts(wallet?: string): Promise<unknown> {
  const owner = wallet ?? ownPublicKey();
  if (!owner) {
    throw new CookieMcpError(
      "no wallet address provided and no wallet configured",
      "pass a `wallet` address, or set COOKIE_PRIVATE_KEY to default to your own wallet",
    );
  }
  const nfts = await fetchUserNfts(owner);
  return {
    wallet: owner,
    count: nfts.length,
    nfts: nfts.map((n) => ({
      mint: n.mint,
      name: n.metadata?.name,
      symbol: n.metadata?.symbol,
      image: n.metadata?.image,
      listed: !!n.listing && (n.listing.status ?? "").toLowerCase() === "active",
      listedPrice: n.listing ? cookUi(n.listing.price) : null,
      url: listingUrl(n.mint),
    })),
  };
}

/** Offers a wallet has made and offers it has received (on NFTs it holds). Default configured wallet. */
export async function getNftOffers(wallet?: string): Promise<unknown> {
  const owner = wallet ?? ownPublicKey();
  if (!owner) {
    throw new CookieMcpError(
      "no wallet address provided and no wallet configured",
      "pass a `wallet` address, or set COOKIE_PRIVATE_KEY to default to your own wallet",
    );
  }
  const [made, received] = await Promise.all([fetchOffersBy(owner), fetchOffersReceived(owner)]);
  const view = (o: BazaarOffer) => ({
    mint: o.nftMint,
    price: cookUi(o.price),
    buyer: o.buyer,
    status: o.status,
    tradeState: o.tradeState,
    expiresAt: o.expiresAt ?? null,
  });
  return {
    wallet: owner,
    made: made.map(view),
    received: received.map(view),
  };
}

/** Marketplace-wide stats (listing count, floor, volume). */
export async function getMarketStats(): Promise<unknown> {
  const s = await fetchStats();
  if (!s) throw new CookieMcpError("could not read marketplace stats", "retry shortly");
  return {
    listingsCount: s.listingsCount,
    floorPrice: s.floorPrice ? cookUi(s.floorPrice) : null,
    totalVolume: s.totalVolume ? cookUi(s.totalVolume) : null,
    volume24h: s.volume24h ? cookUi(s.volume24h) : null,
    salesCount: s.salesCount,
    salesCount24h: s.salesCount24h,
    feePct: AH_SELLER_FEE_BPS / 100,
    marketplace: "Baked Bazaar",
  };
}

/** Read-only collection stats by symbol (supply, holders). */
export async function getCollection(symbol: string): Promise<unknown> {
  const s = await fetchCollectionStats(symbol);
  if (!s) {
    throw new CookieMcpError(
      `collection "${symbol}" not found`,
      "pass the collection symbol shown on a listing (e.g. GORI)",
    );
  }
  return { symbol, totalSupply: s.totalSupply, holderCount: s.holderCount };
}

// --- writes --------------------------------------------------------------------------------------

export interface NftTxResult {
  signature: string;
  action: string;
  mint: string;
  price?: { amount: string; symbol: string };
  explorerUrl: string;
  url: string;
}

/** List an NFT you own for sale at `price` COOK. */
export async function listNft(args: {
  mint: string;
  price: string | number;
}): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const seller = keypair.publicKey;
  const conn = getConnection();
  const mint = new PublicKey(args.mint);
  const priceLamports = toLamports(args.price, "price");

  const sellerTokenAccount = nftTokenAccount(mint, seller);
  const sell = buildSellIx({ seller, sellerTokenAccount, nftMint: mint, price: priceLamports });
  const signature = await sendNftTx(conn, [sell], [keypair]);
  await logTransaction({
    signature,
    type: "list",
    nftMint: args.mint,
    price: priceLamports.toString(),
  });

  return {
    signature,
    action: "list",
    mint: args.mint,
    price: { amount: cookUi(priceLamports), symbol: COOK_SYMBOL },
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

/** Cancel your active listing for an NFT. */
export async function cancelListing(args: { mint: string }): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const seller = keypair.publicKey;
  const conn = getConnection();
  const listing = await requireActiveListing(args.mint);
  if (listing.seller !== seller.toBase58()) {
    throw new CookieMcpError(
      "this listing belongs to another wallet",
      "you can only cancel your own listing",
    );
  }
  const mint = new PublicKey(args.mint);
  const cancel = buildCancelIx({
    wallet: seller,
    tokenAccount: new PublicKey(listing.sellerTokenAccount),
    nftMint: mint,
    price: BigInt(listing.price),
    side: "sell",
  });
  const signature = await sendNftTx(conn, [cancel], [keypair]);
  await logTransaction({ signature, type: "cancel-listing", nftMint: args.mint });
  return {
    signature,
    action: "cancel_listing",
    mint: args.mint,
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

/** Buy a listed NFT at its listing price. Optionally guard with `maxPrice` (COOK). */
export async function buyNft(args: {
  mint: string;
  maxPrice?: string | number;
}): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const buyer = keypair.publicKey;
  const conn = getConnection();
  const listing = await requireActiveListing(args.mint);
  const price = BigInt(listing.price);
  const priceUi = priceCook(price);

  if (args.maxPrice != null && priceUi > Number(args.maxPrice)) {
    throw new CookieMcpError(
      `listing price is ${cookUi(price)} COOK, above your maxPrice of ${args.maxPrice}`,
      "raise maxPrice or wait for a cheaper listing",
    );
  }
  assertWithinSpendCap(priceUi, 1); // spending COOK, valued 1:1

  const mint = new PublicKey(args.mint);
  const seller = new PublicKey(listing.seller);
  const sellerTokenAccount = new PublicKey(listing.sellerTokenAccount);
  const creators = await resolveCreators(conn, mint, listing.metadata?.creators);

  const ixs: TransactionInstruction[] = [
    // buyer receives the NFT into their own ATA
    createAssociatedTokenAccountIdempotentInstruction(
      buyer,
      nftTokenAccount(mint, buyer),
      buyer,
      mint,
    ),
  ];
  const fund = await fundEscrowIx(conn, buyer, price);
  if (fund) ixs.push(fund);
  ixs.push(buildBuyIx({ buyer, sellerTokenAccount, nftMint: mint, price }));
  ixs.push(
    buildExecuteSaleIx({
      buyer,
      seller,
      sellerTokenAccount,
      nftMint: mint,
      price,
      creators,
      buyerSide: "buy",
    }),
  );

  const signature = await sendNftTx(conn, ixs, [keypair]);
  await logTransaction({ signature, type: "buy", nftMint: args.mint, price: price.toString() });
  return {
    signature,
    action: "buy",
    mint: args.mint,
    price: { amount: cookUi(price), symbol: COOK_SYMBOL },
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

/** Make a public offer (bid) on an NFT at `price` COOK. Funds sit in your auction-house escrow until
 * the offer is accepted or cancelled. */
export async function makeOffer(args: {
  mint: string;
  price: string | number;
}): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const buyer = keypair.publicKey;
  const conn = getConnection();
  const mint = new PublicKey(args.mint);
  const price = toLamports(args.price, "price");
  assertWithinSpendCap(priceCook(price), 1);

  const ixs: TransactionInstruction[] = [];
  const fund = await fundEscrowIx(conn, buyer, price);
  if (fund) ixs.push(fund);
  ixs.push(buildPublicBuyIx({ buyer, nftMint: mint, price }));

  const signature = await sendNftTx(conn, ixs, [keypair]);
  await logTransaction({ signature, type: "offer", nftMint: args.mint, price: price.toString() });
  return {
    signature,
    action: "make_offer",
    mint: args.mint,
    price: { amount: cookUi(price), symbol: COOK_SYMBOL },
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

/** Cancel your own offer on an NFT and withdraw the escrowed COOK back to your wallet. */
export async function cancelOffer(args: { mint: string }): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const buyer = keypair.publicKey;
  const conn = getConnection();
  const offers = await fetchOffersBy(buyer.toBase58());
  const offer = offers.find(
    (o) => o.nftMint === args.mint && (o.status ?? "").toLowerCase() === "active",
  );
  if (!offer) {
    throw new CookieMcpError(
      `no active offer from your wallet on ${shortAddr(args.mint)}`,
      "check get_nft_offers for your active offers",
    );
  }
  const mint = new PublicKey(args.mint);
  const price = BigInt(offer.price);
  const cancel = buildCancelIx({
    wallet: buyer,
    tokenAccount: nftTokenAccount(mint, buyer),
    nftMint: mint,
    price,
    side: "publicBuy",
  });
  const withdraw = buildWithdrawIx({ wallet: buyer, amount: price });
  const signature = await sendNftTx(conn, [cancel, withdraw], [keypair]);
  await logTransaction({ signature, type: "cancel-offer", nftMint: args.mint });
  return {
    signature,
    action: "cancel_offer",
    mint: args.mint,
    price: { amount: cookUi(price), symbol: COOK_SYMBOL },
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

/** Accept an offer on an NFT you own (sells it to the bidder). If more than one offer exists, pass
 * `buyer` to disambiguate; otherwise the highest active offer is taken. */
export async function acceptOffer(args: { mint: string; buyer?: string }): Promise<NftTxResult> {
  const { keypair } = requireWallet();
  const seller = keypair.publicKey;
  const conn = getConnection();
  const received = await fetchOffersReceived(seller.toBase58());
  let candidates = received.filter(
    (o) => o.nftMint === args.mint && (o.status ?? "").toLowerCase() === "active",
  );
  if (args.buyer) candidates = candidates.filter((o) => o.buyer === args.buyer);
  if (!candidates.length) {
    throw new CookieMcpError(
      `no active offer to accept on ${shortAddr(args.mint)}${args.buyer ? ` from ${shortAddr(args.buyer)}` : ""}`,
      "check get_nft_offers (received) for offers you can accept",
    );
  }
  // Highest bid first.
  candidates.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? 1 : -1));
  const offer = candidates[0]!;
  const mint = new PublicKey(args.mint);
  const buyer = new PublicKey(offer.buyer);
  const price = BigInt(offer.price);
  const sellerTokenAccount = nftTokenAccount(mint, seller);
  const creators = await resolveCreators(conn, mint);

  const ixs: TransactionInstruction[] = [
    // ensure the buyer has an ATA to receive the NFT (seller pays)
    createAssociatedTokenAccountIdempotentInstruction(
      seller,
      nftTokenAccount(mint, buyer),
      buyer,
      mint,
    ),
    // create the seller trade state at the bid price, then settle against the buyer's public bid
    buildSellIx({ seller, sellerTokenAccount, nftMint: mint, price }),
    buildExecuteSaleIx({
      buyer,
      seller,
      sellerTokenAccount,
      nftMint: mint,
      price,
      creators,
      buyerSide: "publicBuy",
    }),
  ];
  const signature = await sendNftTx(conn, ixs, [keypair]);
  await logTransaction({
    signature,
    type: "accept-offer",
    nftMint: args.mint,
    price: price.toString(),
  });
  return {
    signature,
    action: "accept_offer",
    mint: args.mint,
    price: { amount: cookUi(price), symbol: COOK_SYMBOL },
    explorerUrl: explorerTxUrl(signature),
    url: listingUrl(args.mint),
  };
}

// --- shared internals ----------------------------------------------------------------------------

function toLamports(price: string | number, field: string): bigint {
  let lamports: bigint;
  try {
    lamports = uiToRaw(price, COOK_DECIMALS);
  } catch {
    throw new CookieMcpError(`invalid ${field} "${price}"`, "pass a positive COOK amount");
  }
  if (lamports <= 0n) {
    throw new CookieMcpError(`${field} must be greater than 0`, "pass a positive COOK amount");
  }
  return lamports;
}

async function requireActiveListing(mint: string): Promise<BazaarListing> {
  const listing = (await fetchNft(mint))?.listing ?? null;
  if (!listing || (listing.status ?? "").toLowerCase() !== "active") {
    throw new CookieMcpError(
      `no active listing for ${shortAddr(mint)}`,
      "the NFT may be unlisted or already sold; check get_nft",
    );
  }
  return listing;
}

async function sendNftTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Parameters<typeof signSendConfirm>[2],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return signSendConfirm(conn, tx, signers);
}
