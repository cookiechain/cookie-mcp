import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
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

  it("is the IDL the program repo, backend and frontend carry (anchor #96, upstream sha256 9daf1019…)", () => {
    // Over the parsed content, so formatting is free but any change to an instruction, account,
    // seed or error is not. A deliberate refresh updates this hash.
    expect(createHash("sha256").update(JSON.stringify(nftIdl)).digest("hex")).toBe(
      "220c1e915677d7d591d600de25dab210bb13d94cd641d450d6cab74fa41cac29",
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
