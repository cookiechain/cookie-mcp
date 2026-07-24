import { describe, it, expect } from "vitest";
import type { Connection } from "@solana/web3.js";

import { confirmSent, unconfirmedError } from "./confirm";
import { CookieMcpError } from "./errors";

const SIG = "2SBQCxA9rE8ZDLKmWQXqvL9rGZ8mLZ4bqL7bPzHk44L";

describe("unconfirmedError", () => {
  it("names the action, carries the signature, and forbids a blind retry", () => {
    const e = unconfirmedError("stake", SIG);
    expect(e).toBeInstanceOf(CookieMcpError);
    expect(e.message).toContain("stake");
    expect(e.message).toContain("was sent");
    expect(e.message).toContain(SIG);
    expect(e.hint).toContain("DO NOT retry blindly");
    // The explorer link is what turns the warning into something the agent can act on.
    expect(e.hint).toContain(`/tx/${SIG}`);
    // Points at the usual cause on this chain so the agent can check it.
    expect(e.hint).toContain("chain_health");
  });

  it("never claims the transaction failed — only that it was not confirmed", () => {
    const e = unconfirmedError("transfer", SIG);
    expect(e.message).toContain("could not be confirmed");
    expect(e.message).not.toMatch(/\bfailed\b/);
  });

  it("appends the underlying detail when given", () => {
    const e = unconfirmedError("bridge", SIG, { detail: "block height exceeded" });
    expect(e.message).toContain("block height exceeded");
  });

  it("uses a caller-supplied explorer (the bridge confirms on the SOURCE chain)", () => {
    const e = unconfirmedError("bridge", SIG, {
      explorerUrl: `https://solscan.io/tx/${SIG}`,
    });
    expect(e.hint).toContain(`https://solscan.io/tx/${SIG}`);
    expect(e.hint).not.toContain("cookiescan.io");
  });
});

// A minimal fake Connection: confirmSent only needs confirmTransaction.
const fakeConn = (behaviour: "ok" | "throw" | "err"): Connection =>
  ({
    confirmTransaction: async () => {
      if (behaviour === "throw") throw new Error("TransactionExpiredBlockheightExceededError");
      return { value: behaviour === "err" ? { err: "some error" } : { err: null } };
    },
  }) as unknown as Connection;

const sent = { signature: SIG, blockhash: "Ce3crapsQ2Y8", lastValidBlockHeight: 1_000 };

describe("confirmSent", () => {
  it("returns the signature when confirmation succeeds", async () => {
    await expect(confirmSent(fakeConn("ok"), sent, "stake")).resolves.toBe(SIG);
  });

  it("converts a confirm timeout into the retry-unsafe error, not a raw web3 throw", async () => {
    const err = await confirmSent(fakeConn("throw"), sent, "unstake").catch((e) => e);
    expect(err).toBeInstanceOf(CookieMcpError);
    expect(err.message).toContain("unstake");
    expect(err.message).toContain("TransactionExpiredBlockheightExceededError"); // detail preserved
    expect(err.hint).toContain("DO NOT retry blindly");
  });
});
