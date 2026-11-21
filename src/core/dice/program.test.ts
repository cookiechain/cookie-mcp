import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { PROGRAM_IDS } from "../config";
import diceIdl from "../../idl/cookie_dice.json" with { type: "json" };
import {
  betAddress,
  buildExpireBetTx,
  buildPlaceBetTx,
  DICE_ERRORS,
  diceErrorOf,
  diceProgram,
  gateAddress,
  houseAddress,
  parseResolvedEvents,
  PLACE_BET_CU,
  playerBetFilters,
  vaultAddress,
} from "./program";
import { sha256 } from "./math";

const PLAYER = new PublicKey("zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok");

// Logs of a live settle (bet 23, 2026-11-21): a 100 COOK bet at 46% that rolled 54.06.
const SETTLE_LOGS = [
  "Program DiCe5VcpAHGZCz8pMfVSRRDtvQL6adcdYh5p34DEu1j invoke [1]",
  "Program log: Instruction: SettleBet",
  "Program data: hVlZfQTbUokOwRdXxj52pCGyAUMr40VI5e/rh+DP5kFym8nlnwVlSxcAAAAAAAAAAOh2SBcAAAD4EQAAAAAAAAAAytp4SBoXcM5qh4p7YHkzvh48lO76Hrv3m3PvLTXo4wO+DVd3lDo82DIrXd4DNpTG4B5R1dmCPKkc72+LcAYb6L4NV3eUOjzYMitd3gM2lMbgHlHV2YI8qRzvb4twBhvovGLqgV3QPgZOmuhAlTtl5/tmqWoMe1zGrmpbFaMkQOoXAAAAAAAAAB4VAAAAAAAAAAA=",
  "Program DiCe5VcpAHGZCz8pMfVSRRDtvQL6adcdYh5p34DEu1j consumed 11746 of 200000 compute units",
  "Program DiCe5VcpAHGZCz8pMfVSRRDtvQL6adcdYh5p34DEu1j success",
];

describe("PDAs — golden, against the live deployment", () => {
  it("house / vault / gate", () => {
    expect(houseAddress().toBase58()).toBe("4SgonLVvSXsoawNxjUd1BcWqEu9ACi9kB4MYoFwfJEnS");
    expect(vaultAddress().toBase58()).toBe("88TMP7uqzuZcLn9s1yREeHKFTfGSPBbGA9UGN8cEuoAi");
    expect(gateAddress().toBase58()).toBe("64p8aUBbUpuu8f69FyoSa9YAYf6XdbtUZqzdYaPuEec9");
  });

  it("bet PDA uses the nonce little-endian", () => {
    expect(betAddress(PLAYER, 23n).toBase58()).toBe("5j91kqasBRGRd8Fz6KDvRWpXArjvyVbLHQyhcHU3jzeK");
  });

  it("the IDL is for the configured program", () => {
    expect(diceIdl.address).toBe(PROGRAM_IDS.dice);
  });
});

describe("instructions", () => {
  const program = diceProgram(new Connection("http://127.0.0.1:1"));
  const seed = Buffer.alloc(32, 7);
  const pass = {
    tokenAccount: new PublicKey(Buffer.alloc(32, 1)),
    metadata: new PublicKey(Buffer.alloc(32, 2)),
  };

  it("place_bet: compute budget first, then disc | amount u64 | target u16 | client seed", async () => {
    const tx = await buildPlaceBetTx(program, {
      player: PLAYER,
      nonce: 24n,
      amount: 1_500_000_000n,
      target: 4600,
      clientSeed: seed,
      pass,
    });
    expect(tx.instructions).toHaveLength(2);
    const [budget, ix] = tx.instructions;
    expect(budget!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(budget!.data.readUInt32LE(1)).toBe(PLACE_BET_CU);

    const amount = Buffer.alloc(8);
    amount.writeBigUInt64LE(1_500_000_000n);
    const target = Buffer.alloc(2);
    target.writeUInt16LE(4600);
    expect(ix!.data.toString("hex")).toBe(
      Buffer.concat([
        Buffer.from([222, 62, 67, 220, 63, 166, 126, 33]),
        amount,
        target,
        seed,
      ]).toString("hex"),
    );
    expect(ix!.keys.map((k) => k.pubkey.toBase58())).toEqual([
      PLAYER.toBase58(),
      houseAddress().toBase58(),
      vaultAddress().toBase58(),
      betAddress(PLAYER, 24n).toBase58(),
      SystemProgram.programId.toBase58(),
      gateAddress().toBase58(),
      pass.tokenAccount.toBase58(),
      pass.metadata.toBase58(),
    ]);
    expect(ix!.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
  });

  it("place_bet without a pass fills the optional slots with the program id (Anchor's None)", async () => {
    const tx = await buildPlaceBetTx(program, {
      player: PLAYER,
      nonce: 0n,
      amount: 1n,
      target: 1,
      clientSeed: seed,
      pass: null,
    });
    const keys = tx.instructions[1]!.keys.map((k) => k.pubkey.toBase58());
    expect(keys.slice(6)).toEqual([PROGRAM_IDS.dice, PROGRAM_IDS.dice]);
  });

  it("expire_bet: cranker signs, refund goes to the bet's player", async () => {
    const bet = { address: betAddress(PLAYER, 3n), player: PLAYER };
    const cranker = new PublicKey(Buffer.alloc(32, 5));
    const ix = (await buildExpireBetTx(program, cranker, bet)).instructions[0]!;
    expect([...ix.data]).toEqual([179, 43, 160, 55, 113, 199, 6, 155]);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      cranker.toBase58(),
      houseAddress().toBase58(),
      vaultAddress().toBase58(),
      PLAYER.toBase58(),
      bet.address.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys[0]).toMatchObject({ isSigner: true });
  });

  it("player filter targets the Bet discriminator and the player at offset 8", () => {
    const [disc, player] = playerBetFilters(PLAYER);
    expect(disc!.memcmp.offset).toBe(0);
    expect(player!.memcmp).toEqual({ offset: 8, bytes: PLAYER.toBase58() });
  });
});

describe("parseResolvedEvents", () => {
  it("decodes a live settle (IDL-spelled event + snake_case fields)", () => {
    const [ev] = parseResolvedEvents(SETTLE_LOGS);
    expect(ev).toMatchObject({
      player: PLAYER.toBase58(),
      nonce: 23n,
      amount: 100_000_000_000n,
      target: 4600,
      paid: 0n,
      roll: 5406,
      won: false,
      expired: false,
      seedIndex: 23n,
    });
    expect(sha256(ev!.serverSeed).equals(ev!.commitment)).toBe(true);
  });

  it("ignores logs with no dice event", () => {
    expect(parseResolvedEvents(SETTLE_LOGS.filter((l) => !l.startsWith("Program data")))).toEqual(
      [],
    );
  });
});

describe("DICE_ERRORS", () => {
  it("names the same codes as the deployed IDL", () => {
    expect(Object.entries(DICE_ERRORS).map(([code, e]) => [Number(code), e.name])).toEqual(
      diceIdl.errors.map((e) => [e.code, e.name]),
    );
  });

  it("reads the code from the instruction error, else from the logs", () => {
    expect(diceErrorOf({ InstructionError: [1, { Custom: 6011 }] })?.name).toBe("NotAClubMember");
    expect(
      diceErrorOf("x", ["Program log: AnchorError ... Error Number: 6012. Error Message: stalled"])
        ?.name,
    ).toBe("TableStalled");
    expect(diceErrorOf({ InstructionError: [1, { Custom: 1 }] })).toBeNull();
  });
});
