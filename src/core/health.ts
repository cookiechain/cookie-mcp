// chain_health — one batched JSON-RPC round trip: slot heights per commitment, finalization lag
// (Cookie Chain's key health signal), epoch progress, validator/node counts, version, block rate,
// and RPC latency.
import { COOKIE_RPC_URL } from "./config";
import { rpcBatch, type RpcRes } from "./rpc";

const FINALIZATION_WARN_SLOTS = 150;
const FINALIZATION_STALL_SLOTS = 1000;

export interface ChainHealth {
  healthy: boolean;
  status: "operational" | "degraded" | "down";
  slots: { processed: number | null; confirmed: number | null; finalized: number | null };
  finalizationLag: number | null;
  finalizationStalled: boolean;
  epoch: number | null;
  epochProgressPct: number | null;
  absoluteSlot: number | null;
  blockHeight: number | null;
  version: string | null;
  slotsPerSec: number | null;
  validatorCount: number | null;
  delinquentCount: number | null;
  clusterNodeCount: number | null;
  rpc: { endpoint: string; latencyMs: number | null };
  note?: string;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function slotOf(map: Map<string, RpcRes>, id: string): number | null {
  return num(map.get(id)?.result);
}

export async function getChainHealth(): Promise<ChainHealth> {
  const start = performance.now();
  const map = await rpcBatch([
    { id: "health", method: "getHealth" },
    { id: "epoch", method: "getEpochInfo" },
    { id: "processed", method: "getSlot", params: [{ commitment: "processed" }] },
    { id: "confirmed", method: "getSlot", params: [{ commitment: "confirmed" }] },
    { id: "finalized", method: "getSlot", params: [{ commitment: "finalized" }] },
    { id: "version", method: "getVersion" },
    { id: "perf", method: "getRecentPerformanceSamples", params: [1] },
    { id: "votes", method: "getVoteAccounts", params: [{ commitment: "confirmed" }] },
    { id: "nodes", method: "getClusterNodes" },
  ]);
  const latencyMs = performance.now() - start;

  const health = map.get("health");
  const rpcHealthy = health?.result === "ok" && !health.error;

  const slots = {
    processed: slotOf(map, "processed"),
    confirmed: slotOf(map, "confirmed"),
    finalized: slotOf(map, "finalized"),
  };
  const finalizationLag =
    slots.processed != null && slots.finalized != null ? slots.processed - slots.finalized : null;
  const finalizationStalled =
    finalizationLag != null && finalizationLag >= FINALIZATION_STALL_SLOTS;

  const epochRes = map.get("epoch")?.result as
    | {
        epoch: number;
        slotIndex: number;
        slotsInEpoch: number;
        absoluteSlot: number;
        blockHeight: number;
      }
    | undefined;
  const epochProgressPct =
    epochRes && epochRes.slotsInEpoch > 0
      ? Math.round((epochRes.slotIndex / epochRes.slotsInEpoch) * 1000) / 10
      : null;

  const versionRes = map.get("version")?.result as Record<string, unknown> | undefined;
  const version =
    versionRes && typeof versionRes["solana-core"] === "string"
      ? (versionRes["solana-core"] as string)
      : null;

  const perf = (
    map.get("perf")?.result as Array<{ numSlots: number; samplePeriodSecs: number }> | undefined
  )?.[0];
  const slotsPerSec =
    perf && perf.samplePeriodSecs > 0
      ? Math.round((perf.numSlots / perf.samplePeriodSecs) * 100) / 100
      : null;

  const votesRes = map.get("votes")?.result as
    { current?: unknown[]; delinquent?: unknown[] } | undefined;
  const validatorCount = Array.isArray(votesRes?.current) ? votesRes!.current!.length : null;
  const delinquentCount = Array.isArray(votesRes?.delinquent) ? votesRes!.delinquent!.length : null;
  const nodesRes = map.get("nodes")?.result as unknown[] | undefined;
  const clusterNodeCount = Array.isArray(nodesRes) ? nodesRes.length : null;

  // A finalization stall is "degraded", not "down": blocks still produce.
  let status: ChainHealth["status"] = "operational";
  let note: string | undefined;
  if (!rpcHealthy) {
    status = "down";
    note = "RPC getHealth did not return ok";
  } else if (finalizationStalled) {
    status = "degraded";
    note =
      `finalization stalled (${finalizationLag} slots behind) — finalized reads may return ` +
      `BlockhashNotFound; this server uses confirmed commitment to avoid that`;
  } else if (finalizationLag != null && finalizationLag >= FINALIZATION_WARN_SLOTS) {
    status = "degraded";
    note = `finalization lag elevated (${finalizationLag} slots)`;
  }

  return {
    healthy: status === "operational",
    status,
    slots,
    finalizationLag,
    finalizationStalled,
    epoch: epochRes?.epoch ?? null,
    epochProgressPct,
    absoluteSlot: epochRes?.absoluteSlot ?? null,
    blockHeight: epochRes?.blockHeight ?? null,
    version,
    slotsPerSec,
    validatorCount,
    delinquentCount,
    clusterNodeCount,
    rpc: { endpoint: COOKIE_RPC_URL, latencyMs: Math.round(latencyMs) },
    ...(note ? { note } : {}),
  };
}
