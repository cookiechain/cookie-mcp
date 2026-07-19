import { describe, it, expect } from "vitest";

import { rawToUi, uiToRaw, fmtUsd, shortAddr, bpsToPct } from "./format";

describe("rawToUi", () => {
  it("converts with decimals and trims trailing zeros", () => {
    expect(rawToUi("10000000000", 9)).toBe("10");
    expect(rawToUi("8891410470", 6)).toBe("8891.41047");
    expect(rawToUi("1", 9)).toBe("0.000000001");
    expect(rawToUi(0n, 9)).toBe("0");
  });
  it("handles decimals = 0 and bigint input", () => {
    expect(rawToUi(1234n, 0)).toBe("1234");
  });
  it("handles negatives", () => {
    expect(rawToUi(-1500000000n, 9)).toBe("-1.5");
  });
});

describe("uiToRaw", () => {
  it("round-trips with rawToUi", () => {
    expect(uiToRaw("10", 9)).toBe(10000000000n);
    expect(uiToRaw("8891.41047", 6)).toBe(8891410470n);
    expect(uiToRaw(0.000000001, 9)).toBe(1n);
  });
  it("throws on too many decimal places", () => {
    expect(() => uiToRaw("1.1234567890", 6)).toThrow(/decimal places/);
  });
  it("throws on invalid input", () => {
    expect(() => uiToRaw("abc", 9)).toThrow();
    expect(() => uiToRaw("", 9)).toThrow();
    expect(() => uiToRaw(".", 9)).toThrow();
  });
});

describe("fmtUsd", () => {
  it("formats ranges", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.5");
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.05)).toBe("$0.0500");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd("2.5")).toBe("$2.5");
  });
});

describe("shortAddr / bpsToPct", () => {
  it("shortens long addresses", () => {
    expect(shortAddr("So11111111111111111111111111111111111111112")).toBe("So111…11112");
    expect(shortAddr("short")).toBe("short");
  });
  it("formats bps", () => {
    expect(bpsToPct(500)).toBe("5%");
    expect(bpsToPct(25)).toBe("0.25%");
    expect(bpsToPct(20)).toBe("0.20%");
  });
});
