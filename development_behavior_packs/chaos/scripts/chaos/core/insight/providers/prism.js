// scripts/chaos/core/insight/providers/prism.js

import { getPrismTrace } from "../trace.js";
import { getLogisticsDebugServices } from "../../../features/logistics/runtime/debugContext.js";
import { getInventoryContainer } from "../../../features/logistics/util/inventoryAdapter.js";
import { system } from "@minecraft/server";

const PRISM_PREFIX = "chaos:prism_";
const PRISM_DIAGNOSTIC_CACHE_LIMIT = 64;
const prismDiagnosticCache = new Map();

function parsePrismTier(typeId) {
  if (!typeId || !typeId.startsWith(PRISM_PREFIX)) return 1;
  const part = typeId.slice(PRISM_PREFIX.length);
  const tier = Number(part);
  return Number.isFinite(tier) ? tier : 1;
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

function formatStatusWithReason(status, reason, fallback) {
  if (!status) return "-";
  let finalReason = reason;
  if (!finalReason && status === "no_transfer" && fallback) {
    finalReason = fallback;
  }
  if (!finalReason) return status;
  const reasonText = String(finalReason);
  if (reasonText === status && status !== "no_transfer") {
    return status;
  }
  return `${status}(${reasonText})`;
}

function formatBlockId(typeId) {
  if (!typeId || typeof typeId !== "string") return "none";
  const parts = typeId.split(":");
  return parts[1] || typeId;
}

function getBlockAt(world, dimId, pos) {
  try {
    if (!world || !dimId || !pos) return null;
    const dim = world.getDimension(dimId);
    if (!dim) return null;
    return dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
  } catch {
    return null;
  }
}

function formatAdjacentSummary(block) {
  const dim = block?.dimension;
  const loc = block?.location;
  if (!dim || !loc) return { lines: [], invCount: 0 };
  const base = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  const dirs = [
    { label: "x+", x: 1, y: 0, z: 0 },
    { label: "x-", x: -1, y: 0, z: 0 },
    { label: "y+", x: 0, y: 1, z: 0 },
    { label: "y-", x: 0, y: -1, z: 0 },
    { label: "z+", x: 0, y: 0, z: 1 },
    { label: "z-", x: 0, y: 0, z: -1 },
  ];
  const entries = [];
  let invCount = 0;
  for (const d of dirs) {
    const b = dim.getBlock({ x: base.x + d.x, y: base.y + d.y, z: base.z + d.z });
    if (!b) {
      entries.push(`${d.label}=none`);
      continue;
    }
    const container = getInventoryContainer(b);
    if (!container) {
      entries.push(`${d.label}=${formatBlockId(b.typeId)} no-inv`);
      continue;
    }
    let filled = 0;
    const size = container.size || 0;
    for (let i = 0; i < size; i++) {
      if (container.getItem(i)) filled++;
    }
    invCount++;
    entries.push(`${d.label}=${formatBlockId(b.typeId)} ${filled}/${size}`);
  }
  return { lines: entries, invCount };
}

function formatNeighbors(linkGraph, prismKey, limit = 4) {
  if (!linkGraph?.getNeighbors || !prismKey) return [];
  const neighbors = linkGraph.getNeighbors(prismKey) || [];
  if (neighbors.length === 0) return [];
  return neighbors.slice(0, limit).map((n) => `${n.key}(${n.length})`);
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
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id?.startsWith(PRISM_PREFIX);
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const debugServices = getLogisticsDebugServices();
    const debugEnabled = !!debugServices?.cfg?.debugPrismInspect;
    const prismKey = target?.prismKey || "";
    const tier = parsePrismTier(target?.id);
    const trace = getPrismTrace(prismKey);
    const diag = getPrismDiagnosticSnapshot(prismKey, trace || {});
    const nowTick = Number.isFinite(system?.currentTick) ? system.currentTick : 0;
    const queueSize = Number.isFinite(trace?.queueSize) ? trace.queueSize : 0;
    const cooldownUntil = Number.isFinite(trace?.cooldownUntil) ? trace.cooldownUntil : 0;
    const cooldownLeft = Math.max(0, cooldownUntil - nowTick);
    const edgeCount = debugServices?.linkGraph?.getNeighbors && prismKey
      ? (debugServices.linkGraph.getNeighbors(prismKey) || []).length
      : 0;

    const liveHasInv = hasAdjacentInventory(world, target?.dimId, target?.pos);

    let state = "Idle";
    if (!liveHasInv) state = "Blocked";
    if (queueSize > 0) state = "Busy";
    if (cooldownLeft > 0) state = `Cooling (${cooldownLeft})`;

    const hudLine = `Prism T${tier} | Q${queueSize} | E${edgeCount} | ${state}`;

    const chatLines = [];
    chatLines.push(`Scan ${formatStatusWithReason(diag.scanStatus, diag.scanReason, diag.scanStatus)}`);
    chatLines.push(`Transfer ${formatStatusWithReason(diag.transferStatus, diag.transferReason)}`);
    chatLines.push(`VirtCap ${diag.virtCapacity} ${diag.targetFull ? "full" : "ok"}`);
    if (cooldownLeft > 0) {
      chatLines.push(`Cooldown ${cooldownLeft}`);
    }
    if (diag.neighborInventory) {
      chatLines.push("Neighbor inventory detected");
    }

    if (ctx?.enhanced && debugEnabled) {
      const block = getBlockAt(world, target?.dimId, target?.pos);
      if (block) {
        chatLines.push(`Inspect ${prismKey} ${formatBlockId(block.typeId)}`);
        const adj = formatAdjacentSummary(block);
        if (adj.lines.length > 0) {
          chatLines.push(`Adj ${adj.invCount}/6 ${adj.lines.join(" | ")}`);
        }
        const info = debugServices?.resolveBlockInfo?.(prismKey);
        const filterSet = debugServices?.getFilterSetForBlock?.(debugServices.world, info?.block);
        if (filterSet && filterSet.size > 0) {
          const preview = Array.from(filterSet).slice(0, 6).join(",");
          chatLines.push(`Filter ${preview}${filterSet.size > 6 ? "…" : ""}`);
        } else {
          chatLines.push("Filter none");
        }
        const neighborList = formatNeighbors(debugServices?.linkGraph, prismKey);
        if (neighborList.length > 0) {
          chatLines.push(`Edges ${neighborList.join(" ")}`);
        } else {
          chatLines.push("Edges none");
        }
      } else {
        chatLines.push(`Inspect ${prismKey} (no block)`);
      }
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Prism",
      severity: state,
      includeNetworkSummary: true,
    };
  },
};
