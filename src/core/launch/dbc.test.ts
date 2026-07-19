import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  borshString,
  encodeLaunchData,
  buildLaunchIx,
  deriveDbcPoolAddress,
  DBC_PROGRAM_ID,
  DBC_LAUNCH_CONFIG,
} from "./dbc";
import { COOK_MINT } from "../config";

describe("borshString", () => {
  it("encodes u32 LE length + utf8", () => {
    expect([...borshString("MON")]).toEqual([3, 0, 0, 0, 0x4d, 0x4f, 0x4e]);
    expect([...borshString("")]).toEqual([0, 0, 0, 0]);
  });
});

describe("encodeLaunchData", () => {
  it("prefixes the anchor discriminator then the three strings", () => {
    const data = encodeLaunchData("A", "B", "https://x");
    expect([...data.subarray(0, 8)]).toEqual([140, 85, 215, 176, 102, 54, 104, 79]);
    // name "A" (len 1), symbol "B" (len 1), uri (len 9)
    expect([...data.subarray(8, 13)]).toEqual([1, 0, 0, 0, 0x41]);
    expect([...data.subarray(13, 18)]).toEqual([1, 0, 0, 0, 0x42]);
    expect(data.subarray(22).toString("utf8")).toBe("https://x");
  });
});

describe("buildLaunchIx", () => {
  const payer = Keypair.generate().publicKey;
  const baseMint = Keypair.generate().publicKey;
  const quoteMint = new PublicKey(COOK_MINT);
  const parts = buildLaunchIx({ payer, baseMint, quoteMint, name: "N", symbol: "S", uri: "u" });

  it("targets the DBC program with all 16 accounts", () => {
    expect(parts.ix.programId.equals(DBC_PROGRAM_ID)).toBe(true);
    expect(parts.ix.keys).toHaveLength(16);
  });
  it("marks config read-only, base_mint + payer as signer+writable", () => {
    const config = parts.ix.keys[0]!;
    expect(config.pubkey.equals(DBC_LAUNCH_CONFIG)).toBe(true);
    expect(config.isSigner).toBe(false);
    expect(config.isWritable).toBe(false);
    const baseMintAcct = parts.ix.keys[3]!;
    expect(baseMintAcct.pubkey.equals(baseMint)).toBe(true);
    expect(baseMintAcct.isSigner && baseMintAcct.isWritable).toBe(true);
    const payerAcct = parts.ix.keys[10]!;
    expect(payerAcct.pubkey.equals(payer)).toBe(true);
    expect(payerAcct.isSigner && payerAcct.isWritable).toBe(true);
  });
  it("derives the pool deterministically", () => {
    expect(parts.pool.equals(deriveDbcPoolAddress(DBC_LAUNCH_CONFIG, baseMint, quoteMint))).toBe(
      true,
    );
  });
});

// Golden fixture captured from a build that was verified byte-identical to the reference anchor
// build (2026-07-19). Guards the hand-encoded ix against accidental edits — no external deps.
describe("buildLaunchIx golden bytes", () => {
  const payer = new PublicKey("568tU9FMksJDxjkLBjWisSA4J4C5uPH87NCCkyREwrxe");
  const baseMint = new PublicKey("6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL");
  const quoteMint = new PublicKey("So11111111111111111111111111111111111111112");
  const { ix } = buildLaunchIx({
    payer,
    baseMint,
    quoteMint,
    name: "Cookie Monster",
    symbol: "MON",
    uri: "https://metadata.cookiebox.app/tokens/x/metadata.json",
  });

  it("matches the golden data + account layout", () => {
    expect(Buffer.from(ix.data).toString("hex")).toBe(
      "8c55d7b06636684f0e000000436f6f6b6965204d6f6e73746572030000004d4f4e35000000" +
        "68747470733a2f2f6d657461646174612e636f6f6b6965626f782e6170702f746f6b656e732f782f6d657461646174612e6a736f6e",
    );
    expect(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]),
    ).toEqual([
      ["3yh4ykRE8NKnnXivm3UJjPmqXcbpQAxzJkAsqXZmdGAt", 0, 0],
      ["HSYMkG6iYhdqAgLnZQKGkW5Ce5N9zYq1F3dd6m76y5Ki", 0, 0],
      ["568tU9FMksJDxjkLBjWisSA4J4C5uPH87NCCkyREwrxe", 1, 0],
      ["6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL", 1, 1],
      ["So11111111111111111111111111111111111111112", 0, 0],
      ["EFduQjd6h2jU2ccTZ5iF8TGzC31Kj5pU2ooEH7kL1YDq", 0, 1],
      ["BcT6B3DmqgmY8MG3Z3Rv7wCv2vcJgnGiEEZCgALfkdYi", 0, 1],
      ["EVHLBZYcmQRogLgNxpgFegQWDftZZZ29xsKTCshJpnKk", 0, 1],
      ["J2LfgDReXo9NE3rkeax9osSQUirDCV6dUn3j179qjf96", 0, 1],
      ["metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", 0, 0],
      ["568tU9FMksJDxjkLBjWisSA4J4C5uPH87NCCkyREwrxe", 1, 1],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 0, 0],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 0, 0],
      ["11111111111111111111111111111111", 0, 0],
      ["DHwbE596nxuRZHbq3TDsLuidWJjVwdHB7yvHVpjxASGS", 0, 0],
      ["DBCg4ugDEztk6MbqHEJvx5a5YGJTj45Jb5NvtQ48Rvsf", 0, 0],
    ]);
  });
});
