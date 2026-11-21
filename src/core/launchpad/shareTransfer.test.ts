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
import { userPositionPda } from "./positions";
import {
  encodeTransferSharesData,
  launchpadConfigPda,
  transferSharesAccounts,
  transferSharesRefusal,
  verifyTransferSharesTx,
} from "./shareTransfer";

const programId = new PublicKey(PROGRAM_IDS.momoswapLaunchpad);
const sender = new PublicKey("zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok");
const recipient = new PublicKey("9sDSvszvTePsKpkmjLKgFirgZpN2enHd53KtjeFnM8Rk");
const pool = new PublicKey("3YyYM3J8wa3dda6FBQKP3f1QvDZ7buc12WyvSM4BuUYP");
const want = { programId, sender, recipient, pool, shares: 1_234_567n };

/** What momoswap-backend `buildTransferShares` sends: a CU limit, then `transfer_shares`. */
function backendBuild(
  over: { shares?: bigint; keys?: PublicKey[]; extra?: TransactionInstruction } = {},
) {
  const keys = (over.keys ?? transferSharesAccounts(want)).map((pubkey, i) => ({
    pubkey,
    isSigner: i === 0,
    isWritable: [0, 3, 4, 5].includes(i),
  }));
  const tx = new Transaction();
  tx.feePayer = sender;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
  tx.add(
    new TransactionInstruction({
      programId,
      keys,
      data: encodeTransferSharesData(over.shares ?? want.shares),
    }),
  );
  if (over.extra) tx.add(over.extra);
  return tx;
}

describe("transfer_shares encoding", () => {
  it("is the IDL discriminator then the shares as u64 LE", () => {
    expect([...encodeTransferSharesData(258n)]).toEqual([
      23, 136, 140, 15, 181, 54, 120, 175, 2, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("names the accounts in the program's order, positions as [user, pool, owner] PDAs", () => {
    const keys = transferSharesAccounts(want);
    expect(keys.map((k) => k.toBase58())).toEqual([
      sender.toBase58(),
      recipient.toBase58(),
      launchpadConfigPda(programId).toBase58(),
      pool.toBase58(),
      userPositionPda(pool, sender, programId).toBase58(),
      userPositionPda(pool, recipient, programId).toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
  });
});

describe("verifyTransferSharesTx", () => {
  it("accepts exactly the requested transfer", () => {
    expect(verifyTransferSharesTx(backendBuild(), want)).toBeNull();
  });

  it("refuses a different amount", () => {
    expect(verifyTransferSharesTx(backendBuild({ shares: want.shares + 1n }), want)).toMatch(
      /exactly/,
    );
  });

  it("refuses shares routed to another recipient", () => {
    const other = Keypair.generate().publicKey;
    const keys = transferSharesAccounts({ ...want, recipient: other });
    expect(verifyTransferSharesTx(backendBuild({ keys }), want)).toMatch(/other accounts/);
  });

  it("refuses an extra instruction (e.g. a transfer out of the wallet)", () => {
    const drain = SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: 1 });
    expect(verifyTransferSharesTx(backendBuild({ extra: drain }), want)).toMatch(/also calls/);
  });

  it("refuses another fee payer and an unexpected signer", () => {
    const tx = backendBuild();
    tx.feePayer = recipient;
    expect(verifyTransferSharesTx(tx, want)).toMatch(/paid/);
    const signed = backendBuild();
    signed.instructions[1]!.keys[1]!.isSigner = true;
    expect(verifyTransferSharesTx(signed, want)).toMatch(/signer/);
  });
});

describe("transferSharesRefusal", () => {
  const base = {
    now: 2_000,
    launchTs: 1_000,
    endTs: 10_000,
    antiSnipe: true,
    senderShares: 500n,
    shares: 100n,
    recipientAccount: { owner: SystemProgram.programId, executable: false },
    recipientOnCurve: true,
    recipientHasPosition: false,
    newHolderMinShares: 50n,
    allowUnusedRecipient: false,
    fmt: (raw: bigint) => raw.toString(),
  };

  it("passes a valid transfer", () => {
    expect(transferSharesRefusal(base)).toBeNull();
  });

  it.each([
    [{ now: 20_000 }, /live/],
    [{ now: 1_030 }, /anti-snipe/],
    [{ shares: 600n }, /less than/],
    [{ recipientAccount: { owner: programId, executable: false } }, /program-owned/],
    [{ recipientAccount: null, recipientOnCurve: false }, /nobody holds a key/],
    [{ recipientAccount: null }, /never been used/],
    [{ shares: 10n }, /minimum buy/],
  ])("refuses %o", (over, msg) => {
    expect(transferSharesRefusal({ ...base, ...over })?.message).toMatch(msg);
  });

  it("an unused recipient passes once confirmed; a holder needs no minimum", () => {
    expect(
      transferSharesRefusal({ ...base, recipientAccount: null, allowUnusedRecipient: true }),
    ).toBeNull();
    expect(transferSharesRefusal({ ...base, shares: 10n, recipientHasPosition: true })).toBeNull();
  });
});
