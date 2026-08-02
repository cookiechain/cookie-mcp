import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  ACCOUNT_DISCRIMINATORS,
  clearPrimaryDomainIx,
  configPda,
  decodeDomainAccount,
  decodeDomainsConfigAccount,
  decodePrimaryAccount,
  domainPda,
  domainSimError,
  DOMAINS_PROGRAM_ID,
  encodeRegisterDomainData,
  encodeTransferDomainData,
  IX_DISCRIMINATORS,
  primaryPda,
  registerDomainIx,
  setPrimaryDomainIx,
  transferDomainIx,
  transferNeedsPrimaryCleanup,
  updateDomainPointerIx,
} from "./program";

const OWNER = new PublicKey("FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ");
const FEE_RECEIVER = new PublicKey("HrbhP5Q9ohsY63Ah6abkUJG8jjuYf1esazsAWvKVg1X7");

// Real accounts read from Cookie Chain on 2026-08-02. Golden fixtures: they pin the byte layout
// against silent drift the way bridge.test.ts pins its instruction data.
const FIXTURES = {
  config:
    "mwyq4B76zIKDQOzYzXyfjTky1uJOO/+oFlpG3+4vRVEYU4Rd5tlp0fpvrn2jJYsaMixmrRfROfESF7XVLs077IkXG3fxmHqqZAAAAAAAAABeAQAAAAAAAJYAAAAAAAAACf4=",
  botDomain:
    "I5JicA3m55kDAAAAYm901X0emBarjtdbUlzH8AVVqmw1kqyijfurVL73m0Pald4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAh2sYagAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  clearedPrimary:
    "5/89P464/irVfR6YFquO11tSXMfwBVWqbDWSrKKN+6tUvvebQ9qV3gAAAAD8b3T8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  // `test-test-002`, May 2026: the pre-resolver 85-byte layout.
  legacyDomain:
    "I5JicA3m55kNAAAAdGVzdC10ZXN0LTAwMhE2JE4LefHyCn5c5K/kWKbVk1SnEwp46FUuTQFWGS/BUyj2aQAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAA==",
};
const buf = (b64: string) => Buffer.from(b64, "base64");

describe("PDAs", () => {
  // Golden addresses — each verified to hold a live account on Cookie Chain.
  it("derives the registry config PDA", () => {
    expect(configPda().toBase58()).toBe("4s4DK5eMahyNXe8UarT3q3WPC95Q2wqRfEP19JWXmMGg");
  });

  it("derives a domain PDA from the BARE label", () => {
    expect(domainPda("bot").toBase58()).toBe("8o8kfjiof69r5rnN3HtnmKm89eAVXVznHNKMzxhkeLhk");
    // The `.cook` suffix is presentation only — including it would address a different, empty PDA.
    expect(domainPda("bot.cook").toBase58()).not.toBe(domainPda("bot").toBase58());
  });

  it("derives the per-wallet primary PDA", () => {
    expect(primaryPda(OWNER).toBase58()).toBe("DMAjvHA9TdFNsRUJJ7USDRG6WgMPqkumvwDp1iKC5qnx");
  });
});

describe("instruction encoding", () => {
  it("encodes register_domain as discriminator + borsh string", () => {
    const data = encodeRegisterDomainData("bot");
    expect([...data.subarray(0, 8)]).toEqual([...IX_DISCRIMINATORS.registerDomain]);
    expect(data.readUInt32LE(8)).toBe(3);
    expect(data.subarray(12).toString("utf8")).toBe("bot");
    expect(data.length).toBe(15);
  });

  it("encodes transfer_domain with the variant's own discriminator", () => {
    const plain = encodeTransferDomainData(FEE_RECEIVER, false);
    const cleanup = encodeTransferDomainData(FEE_RECEIVER, true);
    expect([...plain.subarray(0, 8)]).toEqual([...IX_DISCRIMINATORS.transferDomain]);
    expect([...cleanup.subarray(0, 8)]).toEqual([
      ...IX_DISCRIMINATORS.transferDomainWithPrimaryCleanup,
    ]);
    // Both carry the same 32-byte new_owner argument.
    expect(plain.subarray(8)).toEqual(FEE_RECEIVER.toBuffer());
    expect(cleanup.subarray(8)).toEqual(FEE_RECEIVER.toBuffer());
  });

  it("orders register_domain accounts as the program expects", () => {
    const ix = registerDomainIx({ label: "bot", payer: OWNER, feeReceiver: FEE_RECEIVER });
    expect(ix.programId.equals(DOMAINS_PROGRAM_ID)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      configPda().toBase58(),
      domainPda("bot").toBase58(),
      OWNER.toBase58(),
      FEE_RECEIVER.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.map((k) => k.isSigner)).toEqual([false, false, true, false, false]);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([false, true, true, true, false]);
  });

  it("passes the primary PDA only on the cleanup transfer", () => {
    const plain = transferDomainIx({
      label: "bot",
      currentOwner: OWNER,
      newOwner: FEE_RECEIVER,
      withCleanup: false,
    });
    const cleanup = transferDomainIx({
      label: "bot",
      currentOwner: OWNER,
      newOwner: FEE_RECEIVER,
      withCleanup: true,
    });
    expect(plain.keys).toHaveLength(2);
    expect(cleanup.keys).toHaveLength(3);
    expect(cleanup.keys[1].pubkey.toBase58()).toBe(primaryPda(OWNER).toBase58());
    // The signer is the current owner in both shapes.
    expect(plain.keys.at(-1)!.isSigner).toBe(true);
    expect(cleanup.keys.at(-1)!.isSigner).toBe(true);
  });

  it("set/clear primary take the accounts the program declares", () => {
    const set = setPrimaryDomainIx({ label: "bot", owner: OWNER });
    expect(set.keys.map((k) => k.pubkey.toBase58())).toEqual([
      primaryPda(OWNER).toBase58(),
      domainPda("bot").toBase58(),
      OWNER.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect([...set.data]).toEqual([...IX_DISCRIMINATORS.setPrimaryDomain]);

    const clear = clearPrimaryDomainIx({ owner: OWNER });
    expect(clear.keys).toHaveLength(2);
    expect([...clear.data]).toEqual([...IX_DISCRIMINATORS.clearPrimaryDomain]);
  });

  it("routes resolver vs metadata to different instructions", () => {
    const resolver = updateDomainPointerIx({
      label: "bot",
      owner: OWNER,
      field: "resolver",
      value: FEE_RECEIVER,
    });
    const metadata = updateDomainPointerIx({
      label: "bot",
      owner: OWNER,
      field: "metadata",
      value: FEE_RECEIVER,
    });
    expect([...resolver.data.subarray(0, 8)]).toEqual([...IX_DISCRIMINATORS.updateResolver]);
    expect([...metadata.data.subarray(0, 8)]).toEqual([...IX_DISCRIMINATORS.updateMetadata]);
    expect(resolver.data.subarray(8)).toEqual(FEE_RECEIVER.toBuffer());
  });
});

describe("transferNeedsPrimaryCleanup", () => {
  // The cleanup variant requires the primary account to EXIST — a wallet that never set one has no
  // such account, and anchor would fail before the handler runs.
  it("only cleans up when the transferred name IS the current primary", () => {
    expect(transferNeedsPrimaryCleanup("bot", "bot")).toBe(true);
    expect(transferNeedsPrimaryCleanup("bot", "box")).toBe(false);
    expect(transferNeedsPrimaryCleanup("bot", null)).toBe(false);
  });
});

describe("account decoding", () => {
  it("decodes the live registry config", () => {
    const cfg = decodeDomainsConfigAccount(buf(FIXTURES.config));
    expect(cfg).toEqual({
      admin: "9qMq4JXX4TkVzGpTHN8ZZLRTCt2zcMtnVNafdXj8VUik",
      feeReceiver: FEE_RECEIVER.toBase58(),
      cookUsdPriceMicro: 100n,
      shortNameUsdCents: 350n,
      longNameUsdCents: 150n,
      nativeDecimals: 9,
    });
  });

  it("decodes a live domain account, reading fields past the variable-length name", () => {
    const d = decodeDomainAccount(buf(FIXTURES.botDomain));
    expect(d).toEqual({
      name: "bot",
      owner: OWNER.toBase58(),
      resolver: null, // Pubkey::default() means unset
      metadata: null,
      createdAt: 1779985287,
      legacy: false,
    });
  });

  it("decodes the pre-resolver 85-byte layout without inventing pointers", () => {
    const d = decodeDomainAccount(buf(FIXTURES.legacyDomain));
    expect(d).toMatchObject({ name: "test-test-002", legacy: true });
    // Reading the current layout here would surface `created_at` bytes as a resolver pubkey.
    expect(d!.resolver).toBeNull();
    expect(d!.metadata).toBeNull();
    expect(d!.createdAt).toBeNull();
  });

  it("reads a CLEARED primary as no primary, not as an empty name", () => {
    const p = decodePrimaryAccount(buf(FIXTURES.clearedPrimary));
    expect(p).toEqual({ owner: OWNER.toBase58(), name: null });
  });

  it("decodes a primary that points at a name", () => {
    // Same layout with "bot" written in: 8 disc + 32 owner + u32 len + utf8 + bump.
    const data = Buffer.alloc(77);
    Buffer.from(ACCOUNT_DISCRIMINATORS.primary).copy(data, 0);
    OWNER.toBuffer().copy(data, 8);
    data.writeUInt32LE(3, 40);
    data.write("bot", 44, "utf8");
    expect(decodePrimaryAccount(data)).toEqual({ owner: OWNER.toBase58(), name: "bot" });
  });

  it("rejects accounts of the wrong type or truncated data", () => {
    expect(decodeDomainAccount(buf(FIXTURES.config))).toBeNull();
    expect(decodePrimaryAccount(buf(FIXTURES.botDomain))).toBeNull();
    expect(decodeDomainsConfigAccount(buf(FIXTURES.clearedPrimary))).toBeNull();
    expect(decodeDomainAccount(buf(FIXTURES.botDomain).subarray(0, 10))).toBeNull();
  });
});

describe("domainSimError", () => {
  // These log shapes were captured from real simulations against the deployed program.
  it("translates the SYSTEM 0x0 on register into 'already registered'", () => {
    const logs = [
      "Program log: Instruction: RegisterDomain",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
      "Program H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA failed: custom program error: 0x0",
    ];
    expect(domainSimError(logs, "bot")).toBe("bot.cook is already registered");
    expect(domainSimError(logs)).toMatch(/already registered/);
  });

  it("reports the exact shortfall on insufficient lamports", () => {
    const logs = ["Transfer: insufficient lamports 4252874091457, need 15000000000000"];
    expect(domainSimError(logs)).toMatch(/4252874091457.*15000000000000/);
  });

  it("maps anchor error numbers to actionable text", () => {
    expect(
      domainSimError([
        "Program log: AnchorError thrown in programs/cookie_domains/src/lib.rs:51. Error Code: InvalidName. Error Number: 6002. Error Message: Invalid domain name..",
      ]),
    ).toMatch(/invalid domain name/i);
    expect(
      domainSimError([
        "Program log: AnchorError thrown in programs/cookie_domains/src/lib.rs:147. Error Code: NotDomainOwner. Error Number: 6003.",
      ]),
    ).toMatch(/not the owner/);
  });

  it("returns null for anything it cannot improve on, so the raw log survives", () => {
    expect(domainSimError(["Program log: something else entirely"])).toBeNull();
    expect(domainSimError(["Error Number: 9999."])).toBeNull();
  });
});
