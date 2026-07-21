import { describe, it, expect } from "vitest";

import {
  SAMM_PROGRAM_ID,
  SAMM_DEFAULT_AMM_CONFIG,
  MIN_TICK,
  MAX_TICK,
  fullRangeTicks,
  resolveInitialPrice,
} from "./cookieswap";
import { CookieMcpError } from "../errors";

describe("SAMM constants", () => {
  it("is the Cookie SAMM fork program id", () => {
    expect(SAMM_PROGRAM_ID).toBe("WTzkPUoprVx7PDc1tfKA5sS7k1ynCgU89WtwZhksHX5");
    expect(SAMM_DEFAULT_AMM_CONFIG).toBe("JDjWtzVe7TXHjjSqFoL1QSfv8arrCqHPPoBXaUqbe9X4");
  });
});

describe("fullRangeTicks", () => {
  it("aligns the Raydium CLMM hard bounds inward to the tick spacing", () => {
    const { tickLower, tickUpper } = fullRangeTicks(100);
    // MIN_TICK=-443636 -> ceil(-4436.36)*100 = -443600; MAX_TICK=443636 -> floor(4436.36)*100 = 443600
    expect(tickLower).toBe(-443600);
    expect(tickUpper).toBe(443600);
    // stays within the hard bounds and is a multiple of spacing
    expect(tickLower).toBeGreaterThanOrEqual(MIN_TICK);
    expect(tickUpper).toBeLessThanOrEqual(MAX_TICK);
    expect(tickLower % 100 === 0).toBe(true); // multiple of spacing (avoid -0 vs 0)
    expect(tickUpper % 100 === 0).toBe(true);
  });

  it("handles a tick spacing that divides evenly (spacing 2)", () => {
    const { tickLower, tickUpper } = fullRangeTicks(2);
    expect(tickLower).toBe(-443636);
    expect(tickUpper).toBe(443636);
  });
});

describe("resolveInitialPrice", () => {
  it("uses an explicit initialPrice when provided", () => {
    expect(resolveInitialPrice(2.5, 10, 100).toString()).toBe("2.5");
    expect(resolveInitialPrice("0.001", 0, 0).toString()).toBe("0.001");
  });

  it("falls back to the deposit ratio bUi/aUi", () => {
    expect(resolveInitialPrice(undefined, 4, 10).toString()).toBe("2.5");
  });

  it("throws when neither an explicit price nor a usable ratio is available", () => {
    // no initialPrice and bUi = 0 -> ratio 0, not positive
    expect(() => resolveInitialPrice(undefined, 5, 0)).toThrow(CookieMcpError);
    expect(() => resolveInitialPrice(0, 5, 5)).toThrow(/initial price/i);
    expect(() => resolveInitialPrice(-1, 5, 5)).toThrow(/initial price/i);
  });
});
