import { describe, it, expect } from "vitest";

import { nextPoolOffset } from "./api";

// `GET /pools` grew `limit`/`offset` paging (momoswap-frontend #3). `fetchPools` does not send a
// `limit`, so an unpaged server answers the whole list in one call — but a *default* page size on the
// server would silently truncate it, and `get_launchpad_positions` scans that list to decide which
// pools to check. A dropped page there is a position reported as absent with no error, which is why
// the walk exists at all.
describe("nextPoolOffset", () => {
  it("stops on a deployment that does not page at all", () => {
    // The live API today: no `hasMore`, no `nextOffset`, just `{ success, count, pools }`.
    expect(nextPoolOffset({}, 0)).toBeNull();
  });

  it("stops on the last page", () => {
    expect(nextPoolOffset({ hasMore: false, nextOffset: null }, 500)).toBeNull();
  });

  it("advances to the server's cursor", () => {
    expect(nextPoolOffset({ hasMore: true, nextOffset: 500 }, 0)).toBe(500);
    expect(nextPoolOffset({ hasMore: true, nextOffset: 1000 }, 500)).toBe(1000);
  });

  // A `hasMore` with no usable cursor is the shape that would spin forever. Returning a short list is
  // recoverable and visible; a wedged stdio server takes the whole agent session down with it.
  it("stops rather than looping when the cursor cannot advance", () => {
    expect(nextPoolOffset({ hasMore: true, nextOffset: null }, 0)).toBeNull();
    expect(nextPoolOffset({ hasMore: true }, 0)).toBeNull();
    expect(nextPoolOffset({ hasMore: true, nextOffset: 500 }, 500)).toBeNull();
    expect(nextPoolOffset({ hasMore: true, nextOffset: 400 }, 500)).toBeNull();
    expect(nextPoolOffset({ hasMore: true, nextOffset: Number.NaN }, 0)).toBeNull();
    expect(nextPoolOffset({ hasMore: true, nextOffset: 1.5 }, 0)).toBeNull();
    expect(nextPoolOffset({ hasMore: true, nextOffset: "500" } as never, 0)).toBeNull();
  });

  // Only an explicit `true` continues: a truthy-but-not-boolean value means the contract is not what
  // we think it is, and guessing wrong risks paging past the end.
  it("requires hasMore to be exactly true", () => {
    expect(nextPoolOffset({ hasMore: "yes" } as never, 0)).toBeNull();
    expect(nextPoolOffset({ hasMore: 1 } as never, 0)).toBeNull();
  });
});
