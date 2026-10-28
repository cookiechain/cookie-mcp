import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import nftIdl from "../../idl/momo_nft_launchpad.json" with { type: "json" };
import { decodeConfigTreasury, decodeCreatorEscrow, nftConfigPda } from "./chain";

const coder = new BorshAccountsCoder(nftIdl as Idl);
const key = () => Keypair.generate().publicKey;

/** Every field of an IDL account at a zero-ish value, so a test sets only what it reads. */
function zeroed(name: string): Record<string, unknown> {
  const types = (
    nftIdl as unknown as {
      types: { name: string; type: { fields: { name: string; type: unknown }[] } }[];
    }
  ).types;
  const fields = types.find((t) => t.name === name)!.type.fields;
  const zero = (t: unknown): unknown => {
    if (t === "pubkey") return PublicKey.default;
    if (t === "bool") return false;
    if (t === "string") return "";
    if (typeof t === "string") return ["u64", "i64"].includes(t) ? new BN(0) : 0;
    const arr = (t as { array?: [unknown, number] }).array;
    if (arr) return Array.from({ length: arr[1] }, () => 0);
    return { Graduated: {} }; // CollectionState
  };
  return Object.fromEntries(fields.map((f) => [f.name, zero(f.type)]));
}

describe("NFT program account reads", () => {
  it("reads a target drop's held-back creator share and its forfeit deadline", async () => {
    const data = await coder.encode("Collection", {
      ...zeroed("Collection"),
      creator: key(),
      creator_escrow: new BN("2694722855597615"),
      escrow_deadline: new BN(1_800_604_800),
      name: "Ovenborn",
      symbol: "OVEN",
    });
    expect(decodeCreatorEscrow(data)).toEqual({
      heldRaw: 2_694_722_855_597_615n,
      deadline: 1_800_604_800,
    });
  });

  it("reads Config's fee treasury, and refuses an account of another type", async () => {
    const treasury = key();
    const config = await coder.encode("Config", {
      ...zeroed("Config"),
      treasury_payment: treasury,
    });
    expect(decodeConfigTreasury(config)?.toBase58()).toBe(treasury.toBase58());
    expect(decodeCreatorEscrow(config)).toBeNull();
    expect(decodeConfigTreasury(Buffer.alloc(300))).toBeNull();
  });

  it("finds Config at the IDL's seed", () => {
    expect(nftConfigPda().toBase58()).toBe(
      PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        new PublicKey("momoDc2LHwe2Eymo4gK1jg5gAJcjjLGWW1hAaSKAGHb"),
      )[0].toBase58(),
    );
  });
});
