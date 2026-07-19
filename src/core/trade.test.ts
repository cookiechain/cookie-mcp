import { describe, it, expect } from "vitest";

import { simErrorMessage } from "./trade";
import { CookieMcpError } from "./errors";

describe("simErrorMessage", () => {
  it("maps BlockhashNotFound to a chain-stall hint", () => {
    const e = simErrorMessage({ InstructionError: null }, ["Error: BlockhashNotFound"]);
    expect(e).toBeInstanceOf(CookieMcpError);
    expect(e.message).toMatch(/blockhash not found/i);
    expect(e.hint).toMatch(/finalization|stall|chain_health/i);
  });

  it("maps insufficient-funds style errors", () => {
    const e = simErrorMessage("custom program error: 0x1", ["Program log: insufficient funds"]);
    expect(e.message).toMatch(/insufficient/i);
    expect(e.hint).toMatch(/enough|fees|input token/i);
  });

  it("falls back to the last log lines for unknown errors", () => {
    const e = simErrorMessage({ err: "weird" }, ["l1", "l2", "l3", "l4"]);
    expect(e.message).toContain("l4");
    expect(e.hint).toMatch(/re-quote|retry/i);
  });

  it("handles missing logs", () => {
    const e = simErrorMessage({ err: "x" }, null);
    expect(e).toBeInstanceOf(CookieMcpError);
    expect(e.message).toMatch(/simulation failed/i);
  });
});
