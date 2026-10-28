import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { COOK_MINT, RATCHET_KEEPER } from "../config";
import { CLMM_PROGRAM_ID } from "../liquidity/clmm";
import {
  describeDecision,
  directionForSell,
  keeperKind,
  orderStatus,
  pickStopOrder,
  positionHoldings,
  RATCHET_PROGRAM_ID,
  resolveCranker,
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
    const base = { delegated: true, missingPayout: [], missingTickArrays: 0, next: "n" };
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
      missingPayout: [] as string[],
      missingTickArrays: 0,
      next: "n",
    };
    expect(orderStatus({ ...base, delegated: false })).toMatchObject({
      status: "paused",
      detail: expect.stringMatching(/no longer delegated.*stop_ratchet, then start_ratchet/),
    });
    expect(orderStatus({ ...base, missingPayout: ["COOKHOUSE"] }).detail).toMatch(
      /COOKHOUSE token account was closed/,
    );
    expect(orderStatus({ ...base, missingTickArrays: 2 }).detail).toMatch(/2 tick array/);
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
