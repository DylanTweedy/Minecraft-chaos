// scripts/chaos/core/insight/providers/prism.js

import { getPrismTrace } from "../trace.js";
import { system } from "@minecraft/server";

const PRISM_PREFIX = "chaos:prism_";
const DP_PRISM_LEVELS = "chaos:prism_levels_v0_json";

let _lastCountsTick = -9999;
let _countsCache = {};

function parsePrismTier(typeId) {
  if (!typeId || !typeId.startsWith(PRISM_PREFIX)) return 1;
  const part = typeId.slice(PRISM_PREFIX.length);
  const tier = Number(part);
  return Number.isFinite(tier) ? tier : 1;
}

function refreshCounts(world, nowTick) {
  if ((nowTick - _lastCountsTick) < 20) return;
  _lastCountsTick = nowTick;
  try {
    const raw = world?.getDynamicProperty?.(DP_PRISM_LEVELS);
    _countsCache = raw && typeof raw === "string" ? JSON.parse(raw) : {};
  } catch {
    _countsCache = {};
  }
}

function getPrismCount(world, prismKey, nowTick) {
  refreshCounts(world, nowTick);
  const v = _countsCache?.[prismKey];
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function safeParseEvidence(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

const PRISM_DIAGNOSTIC_CACHE_LIMIT = 64;
const prismDiagnosticCache = new Map();

function cachePrismDiagnostic(prismKey, snapshot) {
  if (!prismKey || !snapshot) return;
  if (prismDiagnosticCache.has(prismKey)) {
    prismDiagnosticCache.delete(prismKey);
  }
  while (prismDiagnosticCache.size >= PRISM_DIAGNOSTIC_CACHE_LIMIT) {
    const oldest = prismDiagnosticCache.keys().next().value;
    if (!oldest) break;
    prismDiagnosticCache.delete(oldest);
  }
  prismDiagnosticCache.set(prismKey, snapshot);
}

function getPrismDiagnosticSnapshot(prismKey, trace) {
  const scanTick = trace?.lastScanTick || 0;
  const transferTick = trace?.lastTransferTick || 0;
  const cached = prismDiagnosticCache.get(prismKey);
  if (cached && cached.scanTick === scanTick && cached.transferTick === transferTick) {
    return cached;
  }
  const snapshot = {
    scanStatus: trace?.lastScanStatus || trace?.lastScanResult || "idle",
    scanReason: trace?.lastScanReason || null,
    transferStatus: trace?.lastTransferStatus || trace?.lastTransferResult || "-",
    transferReason: trace?.lastTransferReason || null,
    virtCapacity: Number.isFinite(trace?.lastVirtualCapacity) ? trace.lastVirtualCapacity : 0,
    targetFull: Boolean(trace?.targetContainerFull),
    neighborInventory: Boolean(trace?.hasNeighborInventory),
    registered: Boolean(trace?.registered),
    vcTick: Number.isFinite(trace?.lastVirtualCapacityTick) ? trace.lastVirtualCapacityTick : 0,
    vcReason: trace?.virtualCapacityReason || null,
    vcEvidence: safeParseEvidence(trace?.virtualCapacityEvidence),
    scanTick,
    transferTick,
  };
  cachePrismDiagnostic(prismKey, snapshot);
  return snapshot;
}

function formatStatusWithReason(status, reason, fallbackReason) {
  if (!status) return "-";
  let finalReason = reason;
  if (!finalReason && status === "no_transfer" && fallbackReason) {
    finalReason = fallbackReason;
  }
  if (!finalReason) return status;
  const reasonText = String(finalReason);
  if (reasonText === status && status !== "no_transfer") {
    return status;
  }
  return `${status}(${reasonText})`;
}

function boolFlag(value) {
  return value ? "Y" : "N";
}

function hasAdjacentInventory(world, dimId, pos) {
  try {
    if (!world || !dimId || !pos) return false;
    const dim = world.getDimension(dimId);
    if (!dim) return false;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return false;
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    for (const d of dirs) {
      const adj = dim.getBlock({ x: pos.x + d.x, y: pos.y + d.y, z: pos.z + d.z });
      if (!adj) continue;
      // Most containers expose the inventory component.
      try {
        const inv = adj.getComponent?.("minecraft:inventory");
        if (inv && inv.container) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

export const PrismProvider = {
  id: "prism",
  match(ctx) {
    const focus = ctx?.focus;
    return !!focus && focus.kind === "block" && focus.typeId?.startsWith(PRISM_PREFIX);
  },
  build(ctx) {
    const focus = ctx?.focus;
    const world = ctx?.services?.world;
    const tier = parsePrismTier(focus?.typeId);
    const prismKey = focus?.key || "";
    const trace = getPrismTrace(prismKey);
    const diag = getPrismDiagnosticSnapshot(prismKey, trace || {});
    const nowTick = Number.isFinite(system?.currentTick) ? system.currentTick : 0;
    const queueSize = trace?.queueSize != null ? trace.queueSize : 0;
    const cooldownUntil = trace?.cooldownUntil != null ? (trace.cooldownUntil | 0) : 0;
    const cooldownLeft = Math.max(0, cooldownUntil - nowTick);

    // IMPORTANT: don't trust trace.hasNeighborInventory for player-facing state.
    // It can be stale if scan phases are budgeted off or if a prism was never scanned yet.
    const liveHasInv = hasAdjacentInventory(world, focus?.dimId, focus?.pos);

    let state = "Idle";
    if (!liveHasInv) state = "Blocked (NoInv)";
    if (queueSize > 0) state = "Busy";
    if (cooldownLeft > 0) state = `Cooling (${cooldownLeft})`;

    // Keep actionbar short + player-facing.
    const actionbarLine = `Prism T${tier} • Q${queueSize} • ${state}`;

    return {
      actionbarLine,
      chatLines: [],
      contextKey: prismKey,
      contextLabel: "Prism",
    };
  },
};
