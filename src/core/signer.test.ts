import { describe, it, expect } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

import {
  ExternalSigner,
  LocalKeypairSigner,
  SignatureRequired,
  anchorWalletFor,
  serializeUnsigned,
  signWithCosigners,
  type SignContext,
} from "./signer";
import { assertFullySigned } from "./submit";

const wallet = Keypair.generate();
const cosigner = Keypair.generate();
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));
const ctx: SignContext = {
  what: "stake",
  blockhash: BLOCKHASH,
  lastValidBlockHeight: 123,
  submit: { via: "cookie-rpc" },
  summary: { amount: "1" },
};

function legacyTx(): Transaction {
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 123,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: cosigner.publicKey,
      lamports: 1,
    }),
    SystemProgram.transfer({
      fromPubkey: cosigner.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 1,
    }),
  );
  return tx;
}

function v0Tx(): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: cosigner.publicKey,
        lamports: 1,
      }),
      SystemProgram.transfer({
        fromPubkey: cosigner.publicKey,
        toPubkey: wallet.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("LocalKeypairSigner", () => {
  const signer = new LocalKeypairSigner(wallet);

  it("partial-signs a legacy tx and keeps co-signatures", async () => {
    const tx = legacyTx();
    await signWithCosigners(signer, tx, [cosigner], ctx);
    expect(() => assertFullySigned(tx)).not.toThrow();
    expect(tx.verifySignatures()).toBe(true);
  });

  it("signs a v0 tx into the existing slots", async () => {
    const tx = v0Tx();
    await signWithCosigners(signer, tx, [cosigner], ctx);
    expect(() => assertFullySigned(tx)).not.toThrow();
  });

  it("signs a message with the wallet's ed25519 key", async () => {
    const sig = await signer.signMessage("hello", "test");
    expect(
      ed25519.verify(
        bs58.decode(sig),
        new TextEncoder().encode("hello"),
        wallet.publicKey.toBytes(),
      ),
    ).toBe(true);
  });

  it("does not expose the secret through JSON", () => {
    expect(JSON.stringify(signer)).not.toContain(bs58.encode(wallet.secretKey));
  });
});

describe("ExternalSigner", () => {
  const signer = new ExternalSigner(wallet.publicKey);

  it("stops a legacy flow with the co-signed, verified bytes and the submit route", async () => {
    const tx = legacyTx();
    let err: unknown;
    try {
      await signWithCosigners(signer, tx, [cosigner], ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignatureRequired);
    const p = (err as SignatureRequired).payload;
    if (p.kind !== "transaction") throw new Error("expected a transaction payload");
    expect(p.what).toBe("stake");
    expect(p.signer).toBe(wallet.publicKey.toBase58());
    expect(p.version).toBe("legacy");
    expect(p.blockhash).toBe(BLOCKHASH);
    expect(p.lastValidBlockHeight).toBe(123);
    expect(p.submit).toEqual({ via: "cookie-rpc" });
    expect(p.step).toBe("final");
    expect(p.summary).toEqual({ amount: "1" });
    // The co-signature survived serialisation; only the wallet's slot is empty.
    const back = Transaction.from(Buffer.from(p.transactionBase64, "base64"));
    const co = back.signatures.find((s) => s.publicKey.equals(cosigner.publicKey));
    expect(co?.signature).not.toBeNull();
    expect(back.signatures.find((s) => s.publicKey.equals(wallet.publicKey))?.signature).toBeNull();
    expect(() => assertFullySigned(back)).toThrow(/missing signatures/);
    // A wallet completing it yields something submit_signed_tx accepts.
    back.partialSign(wallet);
    expect(() => assertFullySigned(back)).not.toThrow();
  });

  it("stops a v0 flow the same way", async () => {
    const tx = v0Tx();
    const err = await signWithCosigners(signer, tx, [cosigner], {
      ...ctx,
      step: "intermediate",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SignatureRequired);
    const p = (err as SignatureRequired).payload;
    if (p.kind !== "transaction") throw new Error("expected a transaction payload");
    expect(p.version).toBe("v0");
    expect(p.step).toBe("intermediate");
    expect(p.next).toMatch(/call the same tool again/);
    const back = VersionedTransaction.deserialize(Buffer.from(p.transactionBase64, "base64"));
    expect(() => assertFullySigned(back)).toThrow(/missing signatures/);
    back.sign([wallet]);
    expect(() => assertFullySigned(back)).not.toThrow();
  });

  it("asks for a message signature it does not have", async () => {
    const err = await signer.signMessage("MOMO Login", "launchpad login").catch((e) => e);
    expect(err).toBeInstanceOf(SignatureRequired);
    const p = (err as SignatureRequired).payload;
    expect(p.kind).toBe("message");
    if (p.kind === "message") expect(p.message).toBe("MOMO Login");
  });

  it("accepts a supplied message signature only if it verifies", async () => {
    const good = bs58.encode(
      ed25519.sign(new TextEncoder().encode("MOMO Login"), wallet.secretKey.subarray(0, 32)),
    );
    const ok = new ExternalSigner(wallet.publicKey, [{ message: "MOMO Login", signature: good }]);
    expect(await ok.signMessage("MOMO Login", "login")).toBe(good);

    const bad = bs58.encode(
      ed25519.sign(new TextEncoder().encode("MOMO Login"), cosigner.secretKey.subarray(0, 32)),
    );
    const wrong = new ExternalSigner(wallet.publicKey, [{ message: "MOMO Login", signature: bad }]);
    const err = await wrong.signMessage("MOMO Login", "login").catch((e) => e);
    expect(err).toBeInstanceOf(SignatureRequired);
    expect((err as SignatureRequired).payload.next).toMatch(/does not verify/);
  });
});

describe("helpers", () => {
  it("serializeUnsigned tolerates missing signatures on both formats", () => {
    expect(serializeUnsigned(legacyTx()).version).toBe("legacy");
    expect(serializeUnsigned(v0Tx()).version).toBe("v0");
  });

  it("anchorWalletFor exposes the signer's public key and delegates signing", async () => {
    const w = anchorWalletFor(new LocalKeypairSigner(wallet), ctx);
    expect(w.publicKey.equals(wallet.publicKey)).toBe(true);
    const tx = legacyTx();
    tx.partialSign(cosigner);
    await w.signTransaction(tx);
    expect(tx.verifySignatures()).toBe(true);
    expect(new PublicKey(w.publicKey).toBase58()).toBe(wallet.publicKey.toBase58());
  });
});
