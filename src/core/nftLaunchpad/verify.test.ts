import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { describe, expect, it } from "vitest";

import { PROGRAM_IDS } from "../config";
import nftIdl from "../../idl/momo_nft_launchpad.json" with { type: "json" };
import {
  KIND_INSTRUCTIONS,
  NFT_PROGRAM_ID,
  assertNftBuild,
  instructionByName,
  nftProgramError,
} from "./verify";
import { mintRequestPda } from "./index";

// Real builds from api.momoswap.fun (2026-10-26), unsigned by the wallet: a `buy_nft` on the
// Sweetardios drop for 9rj5GEE…, and a `sell_nft` of item #121 for its holder 3M9AHUd…. The buy is
// partial-signed by the fresh item mint the API generated.
const BUY_TX =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADsE1LGslsV+xpxy2TvUbyvpbi/D2jS7d4kg5o1feVehj/UujkKO3HhPSxWyFHOHZczLKXmn0gBxEWmRikDMgoLAgAJGIOahxesQupI8fIOxPn9sjEWdgRcpHRK7uaWI7VTwpIvoJEzROrslKADs896KoncKnfQPlwg7ElLGU5wJafBQLcb5qwYGZfOF4DwHMeNQl1sbicMTTh+HTNPT+BtBV4wp0FoRQCUBYRPfwB/bJCsCNaZPfdJTkvim5XNOE9gN3jiXCZJvuFcPPSrrvQjBo300Ua6qzgggaWtS/eRvkOsnJhfBkT3sLODPDET9tGKT4VJl87LD77qZteuviDBy8IkcmybR3a6xzOg1gLYlwRK8afsS0mcwVoqhVIZ0ZrLYAqebsw1bhCOIL1fNtWOD6keFaXn5ona9V1Mllacu8ITgtR3x5iYfWdtw4lBSX9b+I7/rW7xILSK2tZeZ2+dI1N7W6BPQNrMZI4rQDN4tRo/Z8Q9yBOEG4mP/8qVvA4HOP0oz8L8cwiiGLi6PhlmeTnvf3R3oTJ3MZUQwoYl9OmsPfTRevlvzSuyhwVWh9EN6Ix5evGCsfWTj/I7VZcIW/TlBNUrhuwk2+NZNgIstPDMT5BAN4XZVm33Ba6540VdXpZX4O1wUjGcpTPkgECzDBNOpeHegAmfyNMtkQtTpQKRQsbyjkAFikLmYgsEUIDBbJtE8KkD3Jk+1aj6fpH+X4h3XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUw+PceLVMsw9YgVb+ND1Wwn9uRtL1W1lhUGvFO1u806MlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAC3BlsePRfEU4nVJ/awTDzVi4bHMaoP21SbbRvAP4KUYLenD3YjIhoifSyYcH4/0AtcT1xoutOpKvzBYyXrR8xgabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABBqfVFxksXFEhjMlMPUrxf1ja7gibof1E49vZigAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqdC2i9zOxXvh0wotVw/R8/3cC1ZpCGMcvBvOuGgGKw1VBRIABQKAGgYAEQYABQAVDxcBAQ8CAAUMAgAAANE0PGBPDAAAFwEFAREUFgAQCgIVBQgJDQEOBgsHDAQDFxETDxYUYAAcvjFrU97xW5CVEQwAAAAAAAA=";
const SELL_TX =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAoTIuA3drTrmQ4DeEvhvJEjl5EwIAOMccz474F65zStKEY1hrxwzdJ9Dq5SdeV+68e83ppzFg7e41W5l4FP3qR4WVu3ioCM+ixSrJgipJ2zzUIqZNt1q+ycKBGkYy8RXS3Id8eYmH1nbcOJQUl/W/iO/61u8SC0itrWXmdvnSNTe1uJWWIKTJ0DvkLoClUdX3/7FPeMKIuxCdhJ4ZXOUERtm6BPQNrMZI4rQDN4tRo/Z8Q9yBOEG4mP/8qVvA4HOP0oz8L8cwiiGLi6PhlmeTnvf3R3oTJ3MZUQwoYl9OmsPfTTZHikT6jWP3h+YjWh0mlPnrRd58MapP5Af6yC8isFguDtcFIxnKUz5IBAswwTTqXh3oAJn8jTLZELU6UCkULGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABTD49x4tUyzD1iBVv40PVbCf25G0vVbWWFQa8U7W7zTk2OhDb7z/CHF4KuwWLFv41nBsqYebv8NQnEDhF4Ei93WqPnzEIr/EVn3sEnEr9M7RqfW4t+zxgZcdZQ4u183s6MlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAC3BlsePRfEU4nVJ/awTDzVi4bHMaoP21SbbRvAP4KUYLenD3YjIhoifSyYcH4/0AtcT1xoutOpKvzBYyXrR8xgabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKmasQUVZstPKqAJJa0l/cQnZ/z2jdC21qtzndiqiMNpCQMOAAUC4JMEAA0GAAEAEQkSAQEQEQAKBgwPCwcEAhEBAwUIEg0JEJ+fjCLw71NZKH6GG5ALAAA=";

const DROP = "8TWT6i5Cpdp81LHmSvZGoAK2AxrVv6D5C5iG51dZ4LF5";
const BUYER = "9rj5GEEypdCbJ1W9is4LHeQxg86h9vxSny6pmsxmakni";
const BUY_CAP = 13_535_056_508_113n;
const SELLER = "3M9AHUdXk66jzTBybJiHhTtj7eewDFU282rQHYvACKRf";
const ITEM = "76peo3d2i7MiELMvZFTZLc2g7qT3df7vtccBuY6ms1dw";
const SELL_MIN = 12_713_564_995_112n;

const buy = () => Transaction.from(Buffer.from(BUY_TX, "base64"));
const sell = () => Transaction.from(Buffer.from(SELL_TX, "base64"));
const buyKnown = { wallet: BUYER, collectionMint: DROP, maxCost: BUY_CAP };
const sellKnown = { wallet: SELLER, collectionMint: DROP, nftMint: ITEM, minProceeds: SELL_MIN };

describe("the vendored IDL", () => {
  it("is the live deployment's program", () => {
    expect((nftIdl as { address: string }).address).toBe(PROGRAM_IDS.momoNftLaunchpad);
    expect(NFT_PROGRAM_ID).toBe("momoDc2LHwe2Eymo4gK1jg5gAJcjjLGWW1hAaSKAGHb");
  });

  it("is the IDL anchor main carries (918d12b, upstream sha256 ca86a51f…), a superset of the backend's (79973de)", () => {
    // Over the parsed content, so formatting is free but any change to an instruction, account,
    // seed or error is not. A deliberate refresh updates this hash.
    expect(createHash("sha256").update(JSON.stringify(nftIdl)).digest("hex")).toBe(
      "f7621611ba1edb87082ad5686c3d846aefe3e49fa98e56688a61b68da91ffaf7",
    );
  });

  it("states Anchor's own discriminator for every instruction a kind may call", () => {
    for (const name of new Set(Object.values(KIND_INSTRUCTIONS).flat(2))) {
      const want = [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
      expect(instructionByName(name)?.discriminator, name).toEqual(want);
    }
  });

  it("maps program errors to their messages", () => {
    expect(nftProgramError(6031)).toEqual({
      name: "SlippageExceeded",
      msg: "Price moved beyond the limit you accepted",
    });
    expect(nftProgramError(1)).toBeNull();
  });
});

describe("assertNftBuild — real builds", () => {
  it("accepts the API's buy_nft and sell_nft", () => {
    expect(assertNftBuild(buy(), "mint", buyKnown)).toEqual(["buy_nft"]);
    expect(assertNftBuild(sell(), "sell", sellKnown)).toEqual(["sell_nft"]);
  });

  it("refuses a build for another collection", () => {
    expect(() =>
      assertNftBuild(buy(), "mint", {
        ...buyKnown,
        collectionMint: "FCnYz1C8NLnfGFL6VuwTjL182P2NqbbB6dYqoYYDwn2y",
      }),
    ).toThrow(/is for collection 8TWT6i5C/);
  });

  it("refuses a sell of an item other than the one named", () => {
    expect(() =>
      assertNftBuild(sell(), "sell", {
        ...sellKnown,
        nftMint: "ESTMQQNFap9ixzFYTSpDVAD7Efi25HGjVuhtRU5sPCrJ",
      }),
    ).toThrow(/not the item asked for/);
  });

  it("refuses a buy whose max_cost exceeds the approved spend", () => {
    expect(() => assertNftBuild(buy(), "mint", { ...buyKnown, maxCost: 1n })).toThrow(
      /more than the 1 approved/,
    );
  });

  it("refuses a sell that accepts less than the minimum asked for", () => {
    expect(() =>
      assertNftBuild(sell(), "sell", { ...sellKnown, minProceeds: SELL_MIN + 1n }),
    ).toThrow(/below the/);
  });

  it("refuses a build of the wrong kind", () => {
    expect(() => assertNftBuild(sell(), "redeem", sellKnown)).toThrow(/expected redeem_floor/);
    expect(() => assertNftBuild(buy(), "request-mint", buyKnown)).toThrow(/expected request_mint/);
  });

  it("refuses another wallet's build", () => {
    expect(() => assertNftBuild(buy(), "mint", { ...buyKnown, wallet: SELLER })).toThrow(
      /fee payer/,
    );
  });
});

describe("assertNftBuild — tampered builds", () => {
  it("refuses an extra transfer out of the wallet", () => {
    const tx = buy();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(BUYER),
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    expect(() => assertNftBuild(tx, "mint", buyKnown)).toThrow(/system-program call/);
  });

  it("refuses a compute-unit price (a fee drain on a chain with no priority fees)", () => {
    const tx = sell();
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }));
    expect(() => assertNftBuild(tx, "sell", sellKnown)).toThrow(
      /compute budget other than a unit limit/,
    );
  });

  it("refuses a PDA slot pointed elsewhere", () => {
    const tx = sell();
    const ix = tx.instructions.find((i) => i.programId.toBase58() === NFT_PROGRAM_ID)!;
    // pool_wallet (index 8) is `["pool_wallet", collection]`, and pool_nft_account (7) is seeded by it,
    // so the swap is caught at whichever of the two is compared first.
    ix.keys[8] = { ...ix.keys[8]!, pubkey: Keypair.generate().publicKey };
    expect(() => assertNftBuild(tx, "sell", sellKnown)).toThrow(
      /pool_\w+ is \w+, not the address its seeds derive/,
    );
  });

  it("refuses an instruction the program has but no kind signs", () => {
    const tx = sell();
    const listing = instructionByName("list_on_marketplace")!;
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(NFT_PROGRAM_ID),
        keys: [],
        data: Buffer.from(listing.discriminator),
      }),
    );
    expect(() => assertNftBuild(tx, "sell", sellKnown)).toThrow(/sell_nft \+ list_on_marketplace/);
  });

  it("refuses an unknown program", () => {
    const tx = sell();
    tx.add(
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [],
        data: Buffer.alloc(0),
      }),
    );
    expect(() => assertNftBuild(tx, "sell", sellKnown)).toThrow(/which no NFT build needs/);
  });
});

describe("assertNftBuild — a reveal built from the IDL", () => {
  const creator = Keypair.generate().publicKey;
  const collectionMint = Keypair.generate().publicKey;
  const programId = new PublicKey(NFT_PROGRAM_ID);
  const [collection] = PublicKey.findProgramAddressSync(
    [Buffer.from("collection"), collectionMint.toBuffer()],
    programId,
  );
  const revealTx = (signer: PublicKey, collectionKey: PublicKey, payer: PublicKey = signer) => {
    const tx = new Transaction({
      feePayer: payer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });
    tx.add(
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: signer, isSigner: true, isWritable: false },
          { pubkey: collectionKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
          Buffer.from(instructionByName("reveal")!.discriminator),
          Buffer.alloc(32, 7),
        ]),
      }),
    );
    return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  };
  const known = { wallet: creator.toBase58(), collectionMint: collectionMint.toBase58() };

  it("accepts the creator's reveal of the named collection", () => {
    expect(assertNftBuild(revealTx(creator, collection), "reveal", known)).toEqual(["reveal"]);
  });

  it("refuses a build we pay for but someone else authorises", () => {
    // The fee payer is ours, so only the instruction's own `creator` slot gives this away.
    const stranger = Keypair.generate().publicKey;
    expect(() => assertNftBuild(revealTx(stranger, collection, creator), "reveal", known)).toThrow(
      /is authorised by .*, not this wallet/,
    );
  });

  it("refuses a reveal of another collection's PDA", () => {
    const [other] = PublicKey.findProgramAddressSync(
      [Buffer.from("collection"), Keypair.generate().publicKey.toBuffer()],
      programId,
    );
    expect(() => assertNftBuild(revealTx(creator, other), "reveal", known)).toThrow(
      /not the address its seeds derive/,
    );
  });
});

describe("assertNftBuild — upkeep built from the IDL", () => {
  const programId = new PublicKey(NFT_PROGRAM_ID);
  const caller = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const collectionMint = Keypair.generate().publicKey;
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const collection = pda(Buffer.from("collection"), collectionMint.toBuffer());
  const known = { wallet: caller.toBase58(), collectionMint: collectionMint.toBase58() };
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const wcook = new PublicKey("So11111111111111111111111111111111111111112");
  const buyerAta = getAssociatedTokenAddressSync(wcook, buyer);

  const txOf = (...ixs: TransactionInstruction[]) => {
    const tx = new Transaction({
      feePayer: caller,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);
    return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  };
  const nftIx = (name: string, keys: [PublicKey, boolean, boolean][]) =>
    new TransactionInstruction({
      programId,
      keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
      data: Buffer.from(instructionByName(name)!.discriminator),
    });

  const refundTx = (signer: PublicKey, request: PublicKey) =>
    txOf(
      createAssociatedTokenAccountIdempotentInstruction(caller, buyerAta, buyer, wcook),
      nftIx("refund_mint", [
        [signer, true, true],
        [collection, false, true],
        [pda(Buffer.from("mint_queue"), collection.toBuffer()), false, true],
        [buyer, false, true],
        [request, false, true],
        [pda(Buffer.from("minter"), collection.toBuffer(), buyer.toBuffer()), false, true],
        [new PublicKey("SysvarS1otHashes111111111111111111111111111"), false, false],
        [wcook, false, false],
        [pda(Buffer.from("payment_vault"), collection.toBuffer()), false, true],
        [buyerAta, false, true],
        [TOKEN, false, false],
      ]),
    );
  const ownRequest = new PublicKey(mintRequestPda(collection.toBase58(), buyer.toBase58()));

  it("accepts a refund of another buyer's request that we pay for, at the request PDA we derive", () => {
    expect(assertNftBuild(refundTx(caller, ownRequest), "refund", known)).toEqual(["refund_mint"]);
  });

  it("refuses a refund at a request address the seeds do not derive", () => {
    expect(() =>
      assertNftBuild(refundTx(caller, Keypair.generate().publicKey), "refund", known),
    ).toThrow(/request is \w+, not the address its seeds derive/);
  });

  it("refuses a refund someone else authorises", () => {
    expect(() =>
      assertNftBuild(refundTx(Keypair.generate().publicKey, ownRequest), "refund", known),
    ).toThrow(/is authorised by .*, not this wallet/);
  });

  const graduateTx = (collectionKey: PublicKey) =>
    txOf(
      nftIx("graduate", [
        [caller, true, false],
        [collectionKey, false, true],
        [wcook, false, false],
        [pda(Buffer.from("payment_vault"), collectionKey.toBuffer()), false, true],
        [pda(Buffer.from("creator_vault"), collectionKey.toBuffer()), false, true],
        [TOKEN, false, false],
      ]),
    );

  it("accepts a graduation of the named drop", () => {
    expect(assertNftBuild(graduateTx(collection), "graduate", known)).toEqual(["graduate"]);
  });

  it("refuses a graduation of another drop", () => {
    const other = pda(Buffer.from("collection"), Keypair.generate().publicKey.toBuffer());
    expect(() => assertNftBuild(graduateTx(other), "graduate", known)).toThrow(
      /not the address its seeds derive/,
    );
  });

  it("refuses a graduate build passed off as a settle", () => {
    expect(() => assertNftBuild(graduateTx(collection), "settle", known)).toThrow(
      /expected settle_mint/,
    );
  });

  // `settle_mint` is the one instruction whose PDA is seeded by an argument: the drawn item's mint
  // derives from the `index` u64, so this is where `argBytes` is held to the IDL.
  const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const indexBytes = (index: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(index);
    return b;
  };
  const settleTx = (signer: PublicKey, index: bigint, itemIndex = index) => {
    const nftMint = pda(Buffer.from("item"), collection.toBuffer(), indexBytes(itemIndex));
    const nftAta = PublicKey.findProgramAddressSync(
      [buyer.toBuffer(), TOKEN.toBuffer(), nftMint.toBuffer()],
      ATA_PROGRAM,
    )[0];
    const ix = new TransactionInstruction({
      programId,
      data: Buffer.concat([
        Buffer.from(instructionByName("settle_mint")!.discriminator),
        indexBytes(index),
      ]),
      keys: (
        [
          [signer, true, true],
          [pda(Buffer.from("config")), false, false],
          [collection, false, true],
          [pda(Buffer.from("mint_queue"), collection.toBuffer()), false, true],
          [buyer, false, true],
          [ownRequest, false, true],
          [new PublicKey("SysvarS1otHashes111111111111111111111111111"), false, false],
          [wcook, false, false],
          [pda(Buffer.from("payment_vault"), collection.toBuffer()), false, true],
          [pda(Buffer.from("creator_vault"), collection.toBuffer()), false, true],
          [pda(Buffer.from("platform_vault"), collection.toBuffer()), false, true],
          [nftMint, false, true],
          [nftAta, false, true],
          [Keypair.generate().publicKey, false, true], // nft_metadata: Metaplex checks it
          [Keypair.generate().publicKey, false, true], // nft_master_edition
          [collectionMint, false, true],
          [pda(Buffer.from("collection_authority"), collectionMint.toBuffer()), false, true],
          [Keypair.generate().publicKey, false, true], // collection_metadata
          [Keypair.generate().publicKey, false, true], // collection_master_edition
          [TOKEN, false, false],
          [ATA_PROGRAM, false, false],
          [METADATA_PROGRAM, false, false],
          [SystemProgram.programId, false, false],
          [new PublicKey("SysvarRent111111111111111111111111111111111"), false, false],
        ] as [PublicKey, boolean, boolean][]
      ).map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
    });
    return txOf(ix);
  };

  it("accepts a settle of the queue head, with the item at the index the argument names", () => {
    expect(assertNftBuild(settleTx(caller, 7n), "settle", known)).toEqual(["settle_mint"]);
  });

  it("refuses a settle whose item is not the one its index argument derives", () => {
    expect(() => assertNftBuild(settleTx(caller, 7n, 8n), "settle", known)).toThrow(
      /nft_mint is \w+, not the address its seeds derive/,
    );
  });

  it("refuses a settle someone else authorises", () => {
    expect(() =>
      assertNftBuild(settleTx(Keypair.generate().publicKey, 7n), "settle", known),
    ).toThrow(/is authorised by .*, not this wallet/);
  });
});

// ── Builds laid out by the IDL itself ────────────────────────────────────────

type IdlSeedT = { kind: string; value?: number[]; path?: string };
type IdlAccountT = {
  name: string;
  signer?: boolean;
  writable?: boolean;
  address?: string;
  pda?: { seeds: IdlSeedT[]; program?: IdlSeedT };
};
const idlInstruction = (name: string) =>
  (
    nftIdl as unknown as { instructions: { name: string; accounts: IdlAccountT[] }[] }
  ).instructions.find((i) => i.name === name)!;

/**
 * An instruction with every slot the IDL fixes (addresses, PDAs) filled in from `given`, the way an
 * honest build lays it out. `given` names the free accounts; anything left free is a fresh key.
 */
function idlIx(
  name: string,
  collectionMint: PublicKey,
  given: Record<string, PublicKey>,
  data: Buffer,
): TransactionInstruction {
  const spec = idlInstruction(name);
  const programId = new PublicKey(NFT_PROGRAM_ID);
  const got: Record<string, PublicKey> = { ...given };
  for (let pass = 0; pass < 4; pass++) {
    for (const a of spec.accounts) {
      if (got[a.name]) continue;
      if (a.address) {
        got[a.name] = new PublicKey(a.address);
        continue;
      }
      if (!a.pda) continue;
      const bytes = (s: IdlSeedT): Buffer | null => {
        if (s.kind === "const") return Buffer.from(s.value!);
        if (s.path === "collection.collection_mint") return collectionMint.toBuffer();
        return got[s.path!]?.toBuffer() ?? null;
      };
      const seeds = a.pda.seeds.map(bytes);
      if (seeds.some((s) => s === null)) continue;
      const program = a.pda.program ? new PublicKey(bytes(a.pda.program)!) : programId;
      got[a.name] = PublicKey.findProgramAddressSync(seeds as Buffer[], program)[0];
    }
  }
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([Buffer.from(instructionByName(name)!.discriminator), data]),
    keys: spec.accounts.map((a) => ({
      pubkey: got[a.name] ?? Keypair.generate().publicKey,
      isSigner: !!a.signer,
      isWritable: !!a.writable,
    })),
  });
}

const unsignedTx = (payer: PublicKey, ...ixs: TransactionInstruction[]) => {
  const tx = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
};

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/** `CollectionParams` in Borsh, field by field from the IDL, so a new field breaks this loudly. */
function encodeCollectionParams(v: Record<string, unknown>): Buffer {
  const fields = (
    nftIdl as unknown as {
      types: { name: string; type: { fields: { name: string; type: unknown }[] } }[];
    }
  ).types.find((t) => t.name === "CollectionParams")!.type.fields;
  return Buffer.concat(
    fields.map((f) => {
      const x = v[f.name];
      if (x === undefined) throw new Error(`no test value for ${f.name}`);
      switch (f.type) {
        case "string": {
          const s = Buffer.from(String(x));
          const len = Buffer.alloc(4);
          len.writeUInt32LE(s.length);
          return Buffer.concat([len, s]);
        }
        case "u16": {
          const b = Buffer.alloc(2);
          b.writeUInt16LE(Number(x));
          return b;
        }
        case "u64":
          return u64(BigInt(x as number));
        case "i64": {
          const b = Buffer.alloc(8);
          b.writeBigInt64LE(BigInt(x as number));
          return b;
        }
        case "bool":
          return Buffer.from([x ? 1 : 0]);
        case "pubkey":
          return new PublicKey(x as string).toBuffer();
        default:
          return Buffer.from(x as Uint8Array); // [u8; 32]
      }
    }),
  );
}

describe("assertNftBuild — a create for the upgraded program (anchor #110, #111)", () => {
  const creator = Keypair.generate().publicKey;
  const collectionMint = Keypair.generate().publicKey;
  const PARTNER = Keypair.generate().publicKey;
  const STRANGER = Keypair.generate().publicKey;
  const programId = new PublicKey(NFT_PROGRAM_ID);
  const [collectionAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("collection_authority"), collectionMint.toBuffer()],
    programId,
  );
  const params = (partner: PublicKey | null, shareBps: number) =>
    encodeCollectionParams({
      name: "Cookie Chads",
      symbol: "CHADS",
      base_uri: "ipfs://bafy/",
      collection_uri: "ipfs://bafy/collection.json",
      total_supply: 444,
      virtual_payment_reserve: 130_441_176_470_223,
      virtual_nft_reserve: 888,
      launch_ts: 1_800_000_000,
      end_ts: 1_800_086_400,
      max_per_wallet: 0,
      anti_snipe: true,
      allowlist_root: new Uint8Array(32),
      allowlist_end_ts: 0,
      commitment: new Uint8Array(32).fill(9),
      seller_fee_bps: 500,
      royalty_partner: (partner ?? SystemProgram.programId).toBase58(),
      partner_share_bps: shareBps,
      floor_lock_bps: 2_000,
    });
  type Extra = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
  const ro = (pubkey: PublicKey): Extra => ({ pubkey, isSigner: false, isWritable: false });
  const createTx = (
    opts: {
      partner?: PublicKey | null;
      shareBps?: number;
      extra?: Extra[];
      tokenAccount?: PublicKey;
    } = {},
  ) => {
    const create = idlIx(
      "create_collection",
      collectionMint,
      {
        creator,
        collection_mint: collectionMint,
        token_program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        ...(opts.tokenAccount ? { collection_token_account: opts.tokenAccount } : {}),
      },
      params(opts.partner ?? null, opts.shareBps ?? 0),
    );
    create.keys.push(...(opts.extra ?? []));
    const vaults = idlIx(
      "init_vaults",
      collectionMint,
      {
        payer: creator,
        payment_mint: new PublicKey("So11111111111111111111111111111111111111112"),
        token_program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      },
      Buffer.alloc(0),
    );
    return unsignedTx(creator, create, vaults);
  };
  const known = (partner: PublicKey | null = null, partnerShareBps = 0) => ({
    wallet: creator.toBase58(),
    graduationTarget: null,
    royaltyPartner: partner?.toBase58() ?? null,
    partnerShareBps,
  });
  const programAta = getAssociatedTokenAddressSync(collectionMint, collectionAuthority, true);
  const creatorAta = getAssociatedTokenAddressSync(collectionMint, creator);

  it("derives the collection NFT's account from the IDL's new seed: the collection authority's ATA", () => {
    const ix = createTx().instructions.find((i) => i.programId.equals(programId))!;
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(programAta.toBase58());
  });

  it("accepts the collection NFT in the program's ATA (upgraded binary) or the creator's (live, for one release)", () => {
    expect(assertNftBuild(createTx({ tokenAccount: programAta }), "create", known())).toEqual([
      "create_collection",
      "init_vaults",
    ]);
    expect(assertNftBuild(createTx({ tokenAccount: creatorAta }), "create", known())).toEqual([
      "create_collection",
      "init_vaults",
    ]);
  });

  it("refuses the collection NFT anywhere else", () => {
    for (const tokenAccount of [
      getAssociatedTokenAddressSync(collectionMint, STRANGER),
      Keypair.generate().publicKey,
    ]) {
      expect(() => assertNftBuild(createTx({ tokenAccount }), "create", known())).toThrow(
        /collection_token_account is \w+, not the address its seeds derive/,
      );
    }
  });

  const withPartner = { partner: PARTNER, shareBps: 2_500 };
  const partnerKnown = known(PARTNER, 2_500);

  it("accepts the royalty partner, read-only, after the accounts when the params name it with a share", () => {
    expect(
      assertNftBuild(createTx({ ...withPartner, extra: [ro(PARTNER)] }), "create", partnerKnown),
    ).toEqual(["create_collection", "init_vaults"]);
  });

  it("accepts a partner create with no extra account, as the backend builds it before #333", () => {
    expect(assertNftBuild(createTx(withPartner), "create", partnerKnown)).toEqual([
      "create_collection",
      "init_vaults",
    ]);
  });

  it("refuses the partner writable or as a signer", () => {
    for (const extra of [
      { pubkey: PARTNER, isSigner: false, isWritable: true },
      { pubkey: PARTNER, isSigner: true, isWritable: false },
    ]) {
      expect(() =>
        assertNftBuild(createTx({ ...withPartner, extra: [extra] }), "create", partnerKnown),
      ).toThrow(/royalty partner it passes has to be read-only/);
    }
  });

  it("refuses another key in the partner's place", () => {
    expect(() =>
      assertNftBuild(createTx({ ...withPartner, extra: [ro(STRANGER)] }), "create", partnerKnown),
    ).toThrow(/passes \w+ after its accounts, not the royalty partner/);
  });

  it("refuses an extra account on a create with no partner, or a partner with no share", () => {
    expect(() => assertNftBuild(createTx({ extra: [ro(STRANGER)] }), "create", known())).toThrow(
      /extra account .*names no royalty partner with a share/,
    );
    expect(() =>
      assertNftBuild(
        createTx({ partner: PARTNER, shareBps: 0, extra: [ro(PARTNER)] }),
        "create",
        known(PARTNER, 0),
      ),
    ).toThrow(/names no royalty partner with a share/);
  });

  it("refuses two extra accounts", () => {
    expect(() =>
      assertNftBuild(
        createTx({ ...withPartner, extra: [ro(PARTNER), ro(PARTNER)] }),
        "create",
        partnerKnown,
      ),
    ).toThrow(/passes 15 accounts; the program takes 13/);
  });

  it("refuses a create whose params name another partner or share than the creator chose", () => {
    expect(() =>
      assertNftBuild(
        createTx({ partner: STRANGER, shareBps: 2_500, extra: [ro(STRANGER)] }),
        "create",
        partnerKnown,
      ),
    ).toThrow(/names royalty partner \w+ at 2500 bps, not the/);
    expect(() =>
      assertNftBuild(createTx({ partner: PARTNER, shareBps: 10_000 }), "create", partnerKnown),
    ).toThrow(/at 10000 bps, not the/);
    expect(() =>
      assertNftBuild(createTx({ ...withPartner, extra: [ro(PARTNER)] }), "create", known()),
    ).toThrow(/not the 11111111111111111111111111111111 at 0 bps/);
  });

  it("refuses params cut short or with bytes left over", () => {
    const tx = createTx();
    const ix = tx.instructions.find((i) => i.programId.equals(programId))!;
    const full = ix.data;
    ix.data = full.subarray(0, full.length - 1);
    expect(() => assertNftBuild(tx, "create", known())).toThrow(/data ends inside floor_lock_bps/);
    ix.data = Buffer.concat([full, Buffer.from([0])]);
    expect(() => assertNftBuild(tx, "create", known())).toThrow(/1 bytes after its arguments/);
  });
});

describe("assertNftBuild — max_cost is the all-in spend (anchor #112, backend #333)", () => {
  const buyer = Keypair.generate().publicKey;
  const collectionMint = Keypair.generate().publicKey;
  const SPEND = 153_000_000_000n; // 150 COOK quoted + 2% fee, the user's approved all-in spend
  const POOL_UNIT = Keypair.generate().publicKey;
  const COST_LEG = 150_000_000_000n; // what the backend sent before #333: the price cap alone
  const known = { wallet: buyer.toBase58(), collectionMint: collectionMint.toBase58() };
  const buyIx = (name: "buy_returned" | "request_mint", maxCost: bigint) =>
    idlIx(
      name,
      collectionMint,
      {
        buyer,
        nft_mint: POOL_UNIT,
        payment_mint: new PublicKey("So11111111111111111111111111111111111111112"),
        buyer_payment_account: getAssociatedTokenAddressSync(
          new PublicKey("So11111111111111111111111111111111111111112"),
          buyer,
        ),
        token_program: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      },
      Buffer.concat([u64(maxCost), Buffer.alloc(4)]), // + an empty allowlist proof
    );
  const realBuy = (maxCost: bigint) => {
    const tx = buy();
    const ix = tx.instructions.find((i) => i.programId.toBase58() === NFT_PROGRAM_ID)!;
    ix.data = Buffer.concat([ix.data.subarray(0, 8), u64(maxCost), ix.data.subarray(16)]);
    return tx;
  };

  it("accepts an all-in max_cost equal to the approved spend, and today's cost-leg one", () => {
    expect(assertNftBuild(realBuy(BUY_CAP), "mint", buyKnown)).toEqual(["buy_nft"]);
    for (const name of ["buy_returned", "request_mint"] as const) {
      const kind = name === "request_mint" ? "request-mint" : "mint";
      for (const maxCost of [SPEND, COST_LEG]) {
        expect(
          assertNftBuild(unsignedTx(buyer, buyIx(name, maxCost)), kind, {
            ...known,
            maxCost: SPEND,
          }),
        ).toEqual([name]);
      }
    }
  });

  it("refuses one lamport over the approved spend on every buy path", () => {
    expect(() => assertNftBuild(realBuy(BUY_CAP + 1n), "mint", buyKnown)).toThrow(
      /more than the \d+ approved/,
    );
    for (const name of ["buy_returned", "request_mint"] as const) {
      const kind = name === "request_mint" ? "request-mint" : "mint";
      expect(() =>
        assertNftBuild(unsignedTx(buyer, buyIx(name, SPEND + 1n)), kind, {
          ...known,
          maxCost: SPEND,
        }),
      ).toThrow(/more than the 153000000000 approved/);
    }
  });

  it("refuses a buy that carries no max_cost at all", () => {
    const tx = buy();
    const ix = tx.instructions.find((i) => i.programId.toBase58() === NFT_PROGRAM_ID)!;
    ix.data = ix.data.subarray(0, 8);
    expect(() => assertNftBuild(tx, "mint", buyKnown)).toThrow(/carries no max_cost/);
  });
});
