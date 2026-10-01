import { afterEach, describe, it, expect, vi } from "vitest";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { BAKED_BAZAAR_API_URL } from "./config";
import { assertFullySigned, submitSignedTransaction } from "./submit";

// A stand-in RPC for the send + confirm half; everything else in this file never reaches it.
const rpc = vi.hoisted(() => ({
  sendRawTransaction: vi.fn(async () => "SIG"),
  confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: "x", lastValidBlockHeight: 1 })),
}));
vi.mock("./rpc", () => ({ getConnection: () => rpc, getSolanaConnection: () => rpc }));

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

describe("submitSignedTransaction and the marketplace indexer", () => {
  const bazaarLog = { type: "offer" as const, nftMint: b.publicKey.toBase58(), price: "5" };

  function signedBase64(): string {
    const tx = new Transaction({
      feePayer: a.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 1 }));
    tx.sign(a);
    return tx.serialize().toString("base64");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    rpc.confirmTransaction.mockClear();
  });

  it("reports bazaarLog with the signature once the transaction confirms", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await submitSignedTransaction({
      signedTransactionBase64: signedBase64(),
      what: "NFT",
      bazaarLog,
    });
    expect(res.confirmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BAKED_BAZAAR_API_URL}/log-transaction`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ signature: "SIG", ...bazaarLog });
  });

  it("reports nothing when the transaction does not confirm", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    rpc.confirmTransaction.mockRejectedValueOnce(new Error("block height exceeded"));
    await expect(
      submitSignedTransaction({ signedTransactionBase64: signedBase64(), what: "NFT", bazaarLog }),
    ).rejects.toThrow(/could not be confirmed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports nothing for a transaction sent on another route", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await submitSignedTransaction({
      signedTransactionBase64: signedBase64(),
      submit: { via: "solana-rpc" },
      what: "NFT",
      bazaarLog,
    });
    expect(res.confirmed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports nothing without a bazaarLog", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await submitSignedTransaction({ signedTransactionBase64: signedBase64(), what: "stake" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
