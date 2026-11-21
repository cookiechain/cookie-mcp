// Dice Club membership. While the program's `Gate` is on, `place_bet` refuses any wallet that cannot
// present a "pass": a classic SPL token account it owns holding ≥ 1 of an NFT whose Metaplex metadata
// names the gate's collection as VERIFIED (Cookie Chads today). This mirrors the program's `gate.rs`
// check for check, so a bet is only sent when the program will accept the pass — the program
// re-checks everything anyway.
//
// The collection is read from the on-chain `Gate` account, never pinned here: if the house points the
// gate at another collection, this follows.
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { metadataPda, TOKEN_METADATA_PROGRAM } from "../nft/auctionHouse";

export interface ClubPass {
  mint: PublicKey;
  /** The player's token account holding it — the program's `pass_token`. */
  tokenAccount: PublicKey;
  /** Its Token Metadata account — `pass_metadata`. */
  metadata: PublicKey;
  /** On-chain name, e.g. "Cookie Chads #123". */
  name: string;
}

export interface MetadataCollection {
  mint: PublicKey;
  name: string;
  collection: { verified: boolean; key: PublicKey } | null;
}

/**
 * Walk a `MetadataV1` account to its `collection` field (gate.rs `parse_metadata`): key · update
 * authority · mint · name/symbol/uri · seller fee · creators? · primary sale · mutable · edition
 * nonce? · token standard? · collection?. `null` for anything malformed.
 */
export function parseMetadataCollection(data: Buffer): MetadataCollection | null {
  let at = 0;
  const take = (n: number) => {
    if (n < 0 || at + n > data.length) throw new RangeError("short");
    const out = data.subarray(at, at + n);
    at += n;
    return out;
  };
  const u8 = () => take(1)[0]!;
  const u32 = () => take(4).readUInt32LE(0);
  const option = () => {
    const tag = u8();
    if (tag > 1) throw new RangeError("bad option tag");
    return tag === 1;
  };
  try {
    if (u8() !== 4) return null; // Key::MetadataV1
    take(32); // update authority
    const mint = new PublicKey(take(32));
    const name = take(u32()).toString("utf8").replace(/\0+$/, "").trim();
    take(u32()); // symbol
    take(u32()); // uri
    take(2); // seller fee bps
    if (option()) take(u32() * 34); // creators
    take(2); // primary sale, mutable
    if (option()) take(1); // edition nonce
    if (option()) take(1); // token standard
    const collection = option() ? { verified: u8() === 1, key: new PublicKey(take(32)) } : null;
    return { mint, name, collection };
  } catch {
    return null;
  }
}

/** Does this metadata prove membership of `collection`? Unverified collection fields don't count. */
export function isMemberMetadata(
  md: MetadataCollection | null,
  mint: PublicKey,
  collection: PublicKey,
): boolean {
  return (
    !!md &&
    md.mint.equals(mint) &&
    !!md.collection?.verified &&
    md.collection.key.equals(collection)
  );
}

const METADATA_BATCH = 100;

/**
 * The wallet's first NFT of `collection`, or null. Candidates are its classic-token accounts holding
 * ≥ 1 of a 0-decimal mint (a listed NFT stays in the wallet on Baked Bazaar, so it still counts).
 */
export async function findClubPass(
  conn: Connection,
  owner: PublicKey,
  collection: PublicKey,
): Promise<ClubPass | null> {
  const { value } = await conn.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID },
    "confirmed",
  );
  const candidates = value
    .filter(({ account }) => {
      const amount = (account.data as { parsed?: { info?: { tokenAmount?: any } } }).parsed?.info
        ?.tokenAmount;
      return amount && amount.decimals === 0 && BigInt(amount.amount) >= 1n;
    })
    .map(({ pubkey, account }) => {
      const mint = new PublicKey(
        (account.data as { parsed: { info: { mint: string } } }).parsed.info.mint,
      );
      return { tokenAccount: pubkey, mint, metadata: metadataPda(mint) };
    });

  for (let i = 0; i < candidates.length; i += METADATA_BATCH) {
    const batch = candidates.slice(i, i + METADATA_BATCH);
    const infos = await conn.getMultipleAccountsInfo(
      batch.map((c) => c.metadata),
      "confirmed",
    );
    for (let j = 0; j < batch.length; j++) {
      const info = infos[j];
      if (!info || !info.owner.equals(TOKEN_METADATA_PROGRAM)) continue;
      const md = parseMetadataCollection(info.data);
      if (isMemberMetadata(md, batch[j]!.mint, collection)) {
        return { ...batch[j]!, name: md!.name };
      }
    }
  }
  return null;
}
