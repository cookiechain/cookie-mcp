import {
  ExtensionType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMintLen,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { COOK_MINT, RATCHET_KEEPER } from "../config";
import { CLMM_PROGRAM_ID } from "../liquidity/clmm";
import {
  depositShortfall,
  describeDecision,
  directionForSell,
  keeperKind,
  orderStatus,
  pickReentry,
  pickStopOrder,
  positionHoldings,
  RATCHET_PROGRAM_ID,
  repairPlan,
  resolveCranker,
  strandedPositionHint,
  transferHookProgramOf,
  type PairTokens,
} from "./index";

const pair: PairTokens = {
  mintA: COOK_MINT,
  mintB: "C4yVWDrwXeEUapmw3BkvktHBxCSsM8MfJ3aPVuFonFi5",
  symA: "COOK",
  symB: "COOKHOUSE",
};

describe("positionHoldings follows the CLMM tick convention", () => {
  it("only A below the range, only B from the upper edge on, both inside", () => {
    expect(positionHoldings(-39297, -39296, -38336)).toBe("a");
    expect(positionHoldings(-39296, -39296, -38336)).toBe("both");
    expect(positionHoldings(-38337, -39296, -38336)).toBe("both");
    expect(positionHoldings(-38336, -39296, -38336)).toBe("b"); // the live position
  });
});

describe("directionForSell", () => {
  it("infers the direction of a one-sided position", () => {
    expect(directionForSell(undefined, pair, "a")).toBe("aToB");
    expect(directionForSell(undefined, pair, "b")).toBe("bToA");
    expect(directionForSell("", pair, "b")).toBe("bToA");
  });

  it("needs to be told for a position holding both tokens", () => {
    expect(() => directionForSell(undefined, pair, "both")).toThrow(
      /holds both COOK and COOKHOUSE/,
    );
    expect(directionForSell(pair.mintB, pair, "both")).toBe("bToA");
    expect(directionForSell(pair.mintA, pair, "both")).toBe("aToB");
  });

  it('accepts "COOK" for the native mint and refuses a mint outside the pool', () => {
    expect(directionForSell("COOK", pair, "a")).toBe("aToB");
    expect(directionForSell("cook", pair, "both")).toBe("aToB");
    expect(() =>
      directionForSell("So11111111111111111111111111111111111111111", pair, "a"),
    ).toThrow(/one of the pool's two tokens/);
  });

  it("refuses to sell a token the position no longer holds (that side already converted)", () => {
    // The live position holds only COOKHOUSE: selling COOK is pointless, selling COOKHOUSE is the order.
    expect(() => directionForSell("COOK", pair, "b")).toThrow(/holds no COOK/);
    expect(directionForSell(pair.mintB, pair, "b")).toBe("bToA");
    expect(() => directionForSell(pair.mintB, pair, "a")).toThrow(/holds no COOKHOUSE/);
  });

  it("falls back to short addresses when a symbol is unknown", () => {
    const anon = { ...pair, symA: null, symB: null };
    expect(() => directionForSell(undefined, anon, "both")).toThrow(/So111…11112 and C4yVW…onFi5/);
  });
});

describe("resolveCranker / keeperKind", () => {
  it("defaults to the Cookiebox keeper", () => {
    for (const input of [undefined, "", "cookiebox", "Keeper"]) {
      const r = resolveCranker(input);
      expect(r.cranker?.toBase58()).toBe(RATCHET_KEEPER);
      expect(r.keeper).toBe("cookiebox");
    }
  });

  it('"anyone" leaves the order unpinned', () => {
    expect(resolveCranker("anyone")).toEqual({ cranker: null, keeper: "anyone" });
    expect(resolveCranker("none").keeper).toBe("anyone");
    expect(keeperKind(null)).toBe("anyone");
  });

  it("a public key is custom unless it is the keeper's", () => {
    const k = PublicKey.unique();
    expect(resolveCranker(k.toBase58())).toEqual({ cranker: k, keeper: "custom" });
    expect(resolveCranker(RATCHET_KEEPER).keeper).toBe("cookiebox");
    expect(keeperKind(new PublicKey(RATCHET_KEEPER))).toBe("cookiebox");
  });

  it("refuses anything else", () => {
    expect(() => resolveCranker("bob")).toThrow(/public key, "cookiebox" or "anyone"/);
  });
});

describe("describeDecision + orderStatus", () => {
  const words = { direction: "bToA" as const, minStep: 1, sold: "COOKHOUSE", received: "COOK" };

  it("names the edge that moves and the token paid out", () => {
    expect(
      describeDecision({ kind: "ratchet", lower: -39296, upper: -38528, liquidity: 1n }, words),
    ).toMatch(/upper edge down to tick -38528 and pays the filled COOK/);
    expect(
      describeDecision(
        { kind: "ratchet", lower: 640, upper: 1408, liquidity: 1n },
        { ...words, direction: "aToB" },
      ),
    ).toMatch(/lower edge up to tick 640/);
    expect(describeDecision({ kind: "finish" }, words)).toMatch(
      /withdraws the COOK and the earned fees/,
    );
    expect(describeDecision({ kind: "wait", reason: "stepTooSmall" }, words)).toMatch(
      /move 1 tick spacing past/,
    );
    expect(
      describeDecision({ kind: "wait", reason: "stepTooSmall" }, { ...words, minStep: 4 }),
    ).toMatch(/move 4 tick spacings past/);
    expect(describeDecision({ kind: "wait", reason: "lastSpacing" }, words)).toMatch(
      /last COOKHOUSE/,
    );
    expect(describeDecision({ kind: "wait", reason: "noLiquidity" }, words)).toMatch(
      /stop_ratchet/,
    );
  });

  it("maps decisions to statuses when nothing is paused", () => {
    const base = {
      delegated: true,
      missingHookMetaLists: [],
      missingPayout: [],
      missingTickArrays: 0,
      next: "n",
    };
    expect(orderStatus({ ...base, decision: { kind: "finish" } }).status).toBe("fully-filled");
    expect(
      orderStatus({ ...base, decision: { kind: "ratchet", lower: 0, upper: 1, liquidity: 1n } })
        .status,
    ).toBe("filling");
    expect(
      orderStatus({ ...base, decision: { kind: "wait", reason: "stepTooSmall" } }).status,
    ).toBe("waiting");
    expect(orderStatus({ ...base, decision: { kind: "wait", reason: "noLiquidity" } }).status).toBe(
      "empty",
    );
    expect(orderStatus({ ...base, decision: { kind: "finish" } }).detail).toBe("n");
  });

  it("a lost delegation, a closed payout account or a missing tick array pauses it", () => {
    const base = {
      decision: { kind: "ratchet", lower: 0, upper: 1, liquidity: 1n } as const,
      delegated: true,
      missingHookMetaLists: [] as string[],
      missingPayout: [] as string[],
      missingTickArrays: 0,
      next: "n",
    };
    expect(orderStatus({ ...base, delegated: false })).toMatchObject({
      status: "paused",
      detail: expect.stringMatching(
        /no longer delegated.*start_ratchet with `position` set to this order's positionMint re-approves/,
      ),
    });
    expect(orderStatus({ ...base, missingPayout: ["COOKHOUSE"] }).detail).toMatch(
      /COOKHOUSE token account was closed.*start_ratchet with `position`.*recreates it/,
    );
    expect(orderStatus({ ...base, missingTickArrays: 2 }).detail).toMatch(
      /2 tick array.*without stopping the order/,
    );
    expect(orderStatus({ ...base, missingHookMetaLists: ["HOOKIE"] })).toMatchObject({
      status: "paused",
      detail: expect.stringMatching(/HOOKIE transfer hook has published no extra-account list/),
    });
    // The hook outranks a closed payout account: no repair of ours can fix it.
    expect(
      orderStatus({ ...base, missingHookMetaLists: ["HOOKIE"], missingPayout: ["X"] }).detail,
    ).toMatch(/transfer hook/);
    // Delegation outranks the rest: without it nothing else matters.
    expect(orderStatus({ ...base, delegated: false, missingPayout: ["X"] }).detail).toMatch(
      /delegated/,
    );
  });
});

describe("pickStopOrder", () => {
  const order = { owner: RATCHET_PROGRAM_ID };
  const position = { owner: CLMM_PROGRAM_ID };
  const none = { arg: null, orderForMint: null, orderForAccount: null, positionForMint: null };

  it("finds the order by NFT mint, position account or its own address", () => {
    expect(pickStopOrder({ ...none, orderForMint: order, positionForMint: position })).toBe(
      "orderForMint",
    );
    expect(pickStopOrder({ ...none, arg: position, orderForAccount: order })).toBe(
      "orderForAccount",
    );
    expect(pickStopOrder({ ...none, arg: order })).toBe("arg");
  });

  it("finds a stale order whose position is gone", () => {
    expect(pickStopOrder({ ...none, orderForMint: order })).toBe("orderForMint");
    expect(pickStopOrder({ ...none, orderForAccount: order })).toBe("orderForAccount");
  });

  it("tells a position without an order from an unknown key", () => {
    expect(pickStopOrder({ ...none, positionForMint: position })).toBe("noOrder");
    expect(pickStopOrder({ ...none, arg: position })).toBe("noOrder");
    expect(pickStopOrder(none)).toBe("notFound");
    // An account some other program owns (a pool mint, a wallet) is neither.
    expect(pickStopOrder({ ...none, arg: { owner: PublicKey.default } })).toBe("notFound");
  });
});

describe("transferHookProgramOf", () => {
  const mint = Keypair.generate().publicKey;
  /** A Token-2022 mint account with one TransferHook extension naming `program`. */
  const hookedMint = (program: PublicKey) => {
    const data = Buffer.alloc(getMintLen([ExtensionType.TransferHook]));
    data[45] = 1; // is_initialized
    data[MINT_SIZE + 83] = 1; // account type: Mint (after the 83-byte padding)
    let o = MINT_SIZE + 83 + 1;
    data.writeUInt16LE(ExtensionType.TransferHook, o); // TLV type
    data.writeUInt16LE(64, o + 2); // TLV length: authority + program id
    o += 4;
    Keypair.generate().publicKey.toBuffer().copy(data, o); // authority
    program.toBuffer().copy(data, o + 32);
    return { owner: TOKEN_2022_PROGRAM_ID, data };
  };

  it("names the hook program of a Token-2022 mint, and null when the program is unset", () => {
    const hook = Keypair.generate().publicKey;
    expect(transferHookProgramOf(mint, hookedMint(hook))?.equals(hook)).toBe(true);
    expect(transferHookProgramOf(mint, hookedMint(PublicKey.default))).toBeNull();
  });

  it("is null for a classic mint or a Token-2022 mint without the extension", () => {
    const plain = Buffer.alloc(MINT_SIZE);
    plain[45] = 1;
    expect(transferHookProgramOf(mint, { owner: TOKEN_PROGRAM_ID, data: plain })).toBeNull();
    expect(transferHookProgramOf(mint, { owner: TOKEN_2022_PROGRAM_ID, data: plain })).toBeNull();
  });

  it("refuses a Token-2022 mint it can't parse rather than call it hook-less", () => {
    expect(() =>
      transferHookProgramOf(mint, { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(3) }),
    ).toThrow(/could not read the Token-2022 extensions/);
  });
});

describe("pickReentry", () => {
  const cand = (liquidity: bigint, held: bigint) => ({
    positionPk: Keypair.generate().publicKey,
    positionMint: Keypair.generate().publicKey,
    liquidity,
    held,
  });

  it("opens a new position when there is nothing to continue with", () => {
    expect(pickReentry([], 1_000n)).toBeNull();
  });

  it("reuses a funded position holding the amount, rounded down by at most 1%", () => {
    const own = cand(5n, 999n);
    expect(pickReentry([own], 1_000n)).toEqual({ kind: "reuse", c: own, more: [] });
    expect(pickReentry([cand(5n, 990n)], 1_000n)?.kind).toBe("reuse");
    expect(pickReentry([cand(5n, 989n)], 1_000n)?.kind).toBe("conflict");
    // Never more than asked: a one-sided deposit can't hold more than its maximum.
    expect(pickReentry([cand(5n, 1_001n)], 1_000n)?.kind).toBe("conflict");
  });

  it("allows two raw units of rounding on a dust amount, where 1% is under a unit", () => {
    expect(pickReentry([cand(5n, 49n)], 50n)?.kind).toBe("reuse");
    expect(pickReentry([cand(5n, 48n)], 50n)?.kind).toBe("reuse");
    expect(pickReentry([cand(5n, 47n)], 50n)?.kind).toBe("conflict");
    expect(pickReentry([cand(5n, 51n)], 50n)?.kind).toBe("conflict");
  });

  it("deposits into an empty one: an open whose deposit half never landed", () => {
    const empty = cand(0n, 0n);
    expect(pickReentry([empty], 1_000n)).toEqual({ kind: "deposit", c: empty, more: [] });
    // A matching funded one wins (that empty one is older); a mismatched one doesn't.
    const match = cand(5n, 1_000n);
    expect(pickReentry([empty, match], 1_000n)).toEqual({ kind: "reuse", c: match, more: [] });
    expect(pickReentry([cand(5n, 7n), empty], 1_000n)).toEqual({
      kind: "deposit",
      c: empty,
      more: [],
    });
  });

  it("refuses rather than guess when the only same-range position holds something else", () => {
    const other = cand(5n, 50n);
    expect(pickReentry([other], 1_000n)).toEqual({ kind: "conflict", c: other, more: [] });
    // Several: the first is named with its amount, the rest ride along for the message.
    const second = cand(5n, 60n);
    expect(pickReentry([other, second], 1_000n)).toEqual({
      kind: "conflict",
      c: other,
      more: [second],
    });
  });
});

describe("strandedPositionHint", () => {
  it("is empty with nothing to name", () => {
    expect(strandedPositionHint([])).toBe("");
  });

  it("names the position and how to continue with it", () => {
    const one = strandedPositionHint(["MintA"]);
    expect(one).toMatch(/^; note you already hold a position/);
    expect(one).toContain('position: "MintA"');
    expect(one).toContain("remove_liquidity");
    const two = strandedPositionHint(["MintA", "MintB"]);
    expect(two).toContain("2 positions");
    expect(two).toContain("NFT MintA, MintB");
    expect(two).toContain('position: "MintA"');
  });
});

describe("depositShortfall", () => {
  const p = { want: 1_500_000_000n, dec: 9, label: "COOK", native: false };

  it("passes a balance that covers the deposit", () => {
    expect(depositShortfall({ ...p, balance: 1_500_000_000n })).toBeNull();
  });

  it("refuses less, naming both amounts, with the fee hint for native COOK only", () => {
    const err = depositShortfall({ ...p, balance: 1_000_000_000n });
    expect(err?.message).toMatch(/holds 1 COOK, less than the 1.5 COOK to deposit/);
    expect(err?.hint).not.toMatch(/fees/);
    expect(depositShortfall({ ...p, balance: 0n, native: true })?.hint).toMatch(/fees/);
  });
});

describe("repairPlan", () => {
  const ok = {
    missingTickArrays: 0,
    missingPayout: 0,
    holdsNft: true,
    delegatedToOrder: true,
    missingHookMetaLists: [] as string[],
  };

  it("refuses when nothing is missing", () => {
    expect(repairPlan(ok)).toEqual({ reapprove: false, refuse: "nothing" });
  });

  it("re-approves only when this wallet holds the NFT", () => {
    expect(repairPlan({ ...ok, delegatedToOrder: false })).toEqual({
      reapprove: true,
      refuse: null,
    });
    expect(repairPlan({ ...ok, delegatedToOrder: false, holdsNft: false })).toEqual({
      reapprove: false,
      refuse: "nftElsewhere",
    });
    // Elsewhere with a tick array missing too: the order stays paused either way, so no rent.
    expect(
      repairPlan({ ...ok, delegatedToOrder: false, holdsNft: false, missingTickArrays: 1 }),
    ).toEqual({ reapprove: false, refuse: "nftElsewhere" });
  });

  it("recreates tick arrays and payout accounts", () => {
    expect(repairPlan({ ...ok, missingTickArrays: 3 }).refuse).toBeNull();
    expect(repairPlan({ ...ok, missingPayout: 1 }).refuse).toBeNull();
  });

  it("names the hook when it is the only thing pausing the order", () => {
    expect(repairPlan({ ...ok, missingHookMetaLists: ["HOOKIE"] }).refuse).toBe("hook");
    expect(repairPlan({ ...ok, missingHookMetaLists: ["HOOKIE"], missingPayout: 1 }).refuse).toBe(
      null,
    );
  });
});
