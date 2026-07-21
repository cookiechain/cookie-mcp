import { describe, it, expect } from "vitest";

import { venueForOwner } from "./index";
import { CP_AMM_PROGRAM_ID } from "./cpAmm";
import { CLMM_PROGRAM_ID } from "./clmm";
import { SAMM_PROGRAM_ID } from "./cookieswap";

describe("venueForOwner", () => {
  it("routes each supported program owner to its venue", () => {
    expect(venueForOwner(CP_AMM_PROGRAM_ID.toBase58())).toBe("cookiebox-damm");
    expect(venueForOwner(CLMM_PROGRAM_ID.toBase58())).toBe("cookiebox-clmm");
    expect(venueForOwner(SAMM_PROGRAM_ID)).toBe("cookieswap-samm");
  });

  it("returns null for an unsupported owner (e.g. the SPL token program)", () => {
    expect(venueForOwner("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBeNull();
    expect(venueForOwner("11111111111111111111111111111111")).toBeNull();
  });
});
