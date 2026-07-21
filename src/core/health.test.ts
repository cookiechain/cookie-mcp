import { describe, it, expect } from "vitest";

import { deriveChainHealth, FINALIZATION_WARN_SLOTS, FINALIZATION_STALL_SLOTS } from "./health";
import type { RpcRes } from "./rpc";

// Build the batched-RPC response map deriveChainHealth consumes. `finalized` defaults to `processed`
// (zero lag) unless overridden, so the "operational" case needs no extra wiring.
function buildMap(
  over: Partial<{
    health: unknown;
    healthError: { code: number; message: string };
    processed: number;
    confirmed: number;
    finalized: number;
    epoch: unknown;
    version: unknown;
    perf: unknown;
    votes: unknown;
    nodes: unknown;
  }> = {},
): Map<string, RpcRes> {
  const processed = over.processed ?? 1000;
  const m = new Map<string, RpcRes>();
  const set = (id: string, result: unknown, error?: { code: number; message: string }) =>
    m.set(id, { id, result, error } as RpcRes);
  set("health", over.health ?? "ok", over.healthError);
  set("processed", processed);
  set("confirmed", over.confirmed ?? processed);
  set("finalized", over.finalized ?? processed);
  set(
    "epoch",
    over.epoch ?? {
      epoch: 42,
      slotIndex: 216_000,
      slotsInEpoch: 432_000,
      absoluteSlot: processed,
      blockHeight: processed - 5,
    },
  );
  set("version", over.version ?? { "solana-core": "1.18.26" });
  set("perf", over.perf ?? [{ numSlots: 300, samplePeriodSecs: 60 }]);
  set("votes", over.votes ?? { current: [1, 2, 3], delinquent: [9] });
  set("nodes", over.nodes ?? [1, 2, 3, 4, 5]);
  return m;
}

describe("deriveChainHealth", () => {
  it("reports operational when RPC is ok and finalization keeps up", () => {
    const h = deriveChainHealth(buildMap(), 12.7);
    expect(h.status).toBe("operational");
    expect(h.healthy).toBe(true);
    expect(h.note).toBeUndefined();
    expect(h.finalizationLag).toBe(0);
    expect(h.finalizationStalled).toBe(false);
    expect(h.rpc.latencyMs).toBe(13); // rounded
  });

  it("parses epoch progress, version, perf, and validator/node counts", () => {
    const h = deriveChainHealth(buildMap(), 0);
    expect(h.epoch).toBe(42);
    expect(h.epochProgressPct).toBe(50); // 216000 / 432000
    expect(h.absoluteSlot).toBe(1000);
    expect(h.blockHeight).toBe(995);
    expect(h.version).toBe("1.18.26");
    expect(h.slotsPerSec).toBe(5); // 300 / 60
    expect(h.validatorCount).toBe(3);
    expect(h.delinquentCount).toBe(1);
    expect(h.clusterNodeCount).toBe(5);
  });

  it("is down when RPC getHealth is not ok", () => {
    const h = deriveChainHealth(
      buildMap({ health: null, healthError: { code: -32005, message: "unhealthy" } }),
      5,
    );
    expect(h.status).toBe("down");
    expect(h.healthy).toBe(false);
    expect(h.note).toMatch(/getHealth did not return ok/i);
  });

  it("is degraded (not down) on a finalization stall — blocks still produce", () => {
    const h = deriveChainHealth(
      buildMap({ processed: 5000, finalized: 5000 - FINALIZATION_STALL_SLOTS }),
      5,
    );
    expect(h.status).toBe("degraded");
    expect(h.finalizationStalled).toBe(true);
    expect(h.finalizationLag).toBe(FINALIZATION_STALL_SLOTS);
    expect(h.note).toMatch(/finalization stalled/i);
  });

  it("is degraded with an elevated-lag note between the warn and stall thresholds", () => {
    const h = deriveChainHealth(
      buildMap({ processed: 5000, finalized: 5000 - (FINALIZATION_WARN_SLOTS + 1) }),
      5,
    );
    expect(h.status).toBe("degraded");
    expect(h.finalizationStalled).toBe(false);
    expect(h.note).toMatch(/lag elevated/i);
  });

  it("tolerates missing/garbage fields by returning nulls", () => {
    const m = new Map<string, RpcRes>();
    m.set("health", { id: "health", result: "ok" } as RpcRes);
    const h = deriveChainHealth(m, 3);
    expect(h.slots).toEqual({ processed: null, confirmed: null, finalized: null });
    expect(h.finalizationLag).toBeNull();
    expect(h.epoch).toBeNull();
    expect(h.epochProgressPct).toBeNull();
    expect(h.version).toBeNull();
    expect(h.slotsPerSec).toBeNull();
    expect(h.validatorCount).toBeNull();
    expect(h.status).toBe("operational"); // health ok, no lag signal
  });
});
