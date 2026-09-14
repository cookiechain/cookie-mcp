import { describe, it, expect } from "vitest";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { assertFullySigned, submitSignedTransaction } from "./submit";

const a = Keypair.generate();
const b = Keypair.generate();
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 9));

describe("assertFullySigned", () => {
  it("names the missing signer on a v0 transaction", () => {
    const msg = new TransactionMessage({
      payerKey: a.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [
        SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: a.publicKey, lamports: 1 }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([a]);
    expect(() => assertFullySigned(tx)).toThrow(b.publicKey.toBase58());
    tx.sign([b]);
    expect(() => assertFullySigned(tx)).not.toThrow();
  });

  it("rejects a legacy transaction whose signature does not verify", () => {
    const tx = new Transaction({
      feePayer: a.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 1 }));
    tx.sign(a);
    tx.instructions[0]!.data = Buffer.from([1, 2, 3]); // tamper after signing
    expect(() => assertFullySigned(tx)).toThrow(/does not verify/);
  });
});

describe("submitSignedTransaction input validation", () => {
  it("refuses garbage before touching the network", async () => {
    await expect(submitSignedTransaction({ signedTransactionBase64: "" })).rejects.toThrow(/empty/);
    await expect(submitSignedTransaction({ signedTransactionBase64: "AAAA" })).rejects.toThrow(
      /could not deserialize/,
    );
  });

  it("refuses an unsigned transaction before touching the network", async () => {
    const tx = new Transaction({
      feePayer: a.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 1 }));
    const base64 = tx.serialize({ requireAllSignatures: false }).toString("base64");
    await expect(submitSignedTransaction({ signedTransactionBase64: base64 })).rejects.toThrow(
      /missing signatures/,
    );
  });
});
