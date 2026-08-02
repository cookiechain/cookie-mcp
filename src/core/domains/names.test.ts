import { describe, it, expect } from "vitest";

import {
  displayName,
  isValidName,
  looksLikeName,
  MAX_NAME_LENGTH,
  nameError,
  normalizeName,
  priceTier,
  registrationPriceRaw,
  type DomainsConfig,
} from "./names";

// The live registry config, read from `4s4DK5eM…` on 2026-08-02. Golden: the price assertions below
// were cross-checked against the deployed program by simulating `register_domain`, which reports the
// exact lamports it demands ("insufficient lamports …, need 35000000000000").
const LIVE_CONFIG: DomainsConfig = {
  admin: "9qMq4JXX4TkVzGpTHN8ZZLRTCt2zcMtnVNafdXj8VUik",
  feeReceiver: "HrbhP5Q9ohsY63Ah6abkUJG8jjuYf1esazsAWvKVg1X7",
  cookUsdPriceMicro: 100n,
  shortNameUsdCents: 350n,
  longNameUsdCents: 150n,
  nativeDecimals: 9,
};

describe("normalizeName", () => {
  it("strips the .cook suffix and lowercases", () => {
    expect(normalizeName("Bot.cook")).toBe("bot");
    expect(normalizeName("  BOT  ")).toBe("bot");
    expect(normalizeName("bot")).toBe("bot");
  });

  it("only strips a trailing suffix, never an inner one", () => {
    expect(normalizeName("cook.cook")).toBe("cook");
    expect(normalizeName("my.cookbook")).toBe("my.cookbook");
  });

  it("round-trips through displayName", () => {
    expect(displayName(normalizeName("BOT.cook"))).toBe("bot.cook");
  });
});

describe("nameError", () => {
  it("accepts what the dApp accepts", () => {
    for (const ok of ["a", "0", "bot", "42", "cook-oven", "a".repeat(MAX_NAME_LENGTH)]) {
      expect(nameError(ok), ok).toBeNull();
      expect(isValidName(ok)).toBe(true);
    }
  });

  it("rejects each rule with its own reason", () => {
    expect(nameError("")).toMatch(/empty/);
    expect(nameError("a".repeat(MAX_NAME_LENGTH + 1))).toMatch(/longer than 32/);
    expect(nameError("Bot")).toMatch(/a-z/);
    expect(nameError("bad_name")).toMatch(/a-z/);
    expect(nameError("bad name")).toMatch(/a-z/);
    expect(nameError("-bot")).toMatch(/hyphen/);
    expect(nameError("bot-")).toMatch(/hyphen/);
  });

  it("counts BYTES against the 32-byte PDA seed limit, not code points", () => {
    // 32 emoji would be 128 bytes; the charset check fires first, but the byte rule must hold for
    // anything that reaches it — findProgramAddressSync throws on a seed over 32 bytes.
    expect(nameError("🍪".repeat(9))).not.toBeNull();
    expect(Buffer.byteLength("🍪".repeat(9))).toBeGreaterThan(MAX_NAME_LENGTH);
  });
});

describe("looksLikeName", () => {
  it("treats an explicit .cook suffix as a name", () => {
    expect(looksLikeName("bot.cook")).toBe(true);
    expect(looksLikeName("BOT.COOK")).toBe(true);
  });

  it("treats a well-formed base58 pubkey as an address", () => {
    expect(looksLikeName("FNNVmNtTFhQtcU6Rp554aS5aDaEhhQqvjX9HLFNKoYEZ")).toBe(false);
    expect(looksLikeName("So11111111111111111111111111111111111111112")).toBe(false);
  });

  it("treats a bare label as a name — a 32-char label can never be a 32-BYTE pubkey", () => {
    expect(looksLikeName("bot")).toBe(true);
    expect(looksLikeName("cook-oven")).toBe(true);
    // 32 base58 chars decode to ~23 bytes, so PublicKey would reject it anyway.
    expect(looksLikeName("a".repeat(32))).toBe(false);
    expect(nameError("a".repeat(32))).toBeNull();
  });
});

describe("registrationPriceRaw", () => {
  it("prices 1–3 character names at the short tier", () => {
    expect(priceTier("a")).toBe("short");
    expect(priceTier("bot")).toBe("short");
    expect(priceTier("cook")).toBe("long");
  });

  it("matches the lamports the deployed program demands", () => {
    // Golden values from live simulation against H43Qtq4A… on 2026-08-02.
    expect(registrationPriceRaw(LIVE_CONFIG, "zz9")).toBe(35_000_000_000_000n);
    expect(registrationPriceRaw(LIVE_CONFIG, "mcp-probe-xyz-0001")).toBe(15_000_000_000_000n);
  });

  it("tracks a config change without a code change", () => {
    const cheaper = { ...LIVE_CONFIG, cookUsdPriceMicro: 1_000n };
    expect(registrationPriceRaw(cheaper, "bot")).toBe(3_500_000_000_000n);
  });

  it("floors like the program's integer division", () => {
    const odd = { ...LIVE_CONFIG, cookUsdPriceMicro: 3n, longNameUsdCents: 1n };
    expect(registrationPriceRaw(odd, "cook")).toBe((1n * 10_000n * 10n ** 9n) / 3n);
  });

  it("refuses to divide by a zero COOK price rather than returning Infinity", () => {
    expect(() => registrationPriceRaw({ ...LIVE_CONFIG, cookUsdPriceMicro: 0n }, "bot")).toThrow();
  });
});
