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
    const queueSize = trace?.queueSize != null ? trace.queueSize : 0;
    const nowTick = Number.isFinite(system?.currentTick) ? system.currentTick : 0;
    const scanLabel = formatStatusWithReason(diag.scanStatus, diag.scanReason, diag.vcReason);
    const pathMs = trace?.lastPathfindMs ? `${trace.lastPathfindMs}ms` : "-";
    const transferLabel = formatStatusWithReason(
      diag.transferStatus,
      diag.transferReason,
      diag.vcReason
    );
    const rawVirtCap = Number.isFinite(diag?.virtCapacity)
      ? Math.max(0, Math.floor(Number(diag.virtCapacity) || 0))
      : 0;
    const vcTick = Number.isFinite(diag?.vcTick) ? diag.vcTick : 0;
    const vcAge = Number.isFinite(vcTick) ? nowTick - vcTick : Number.MAX_SAFE_INTEGER;
    const vcFresh = Number.isFinite(vcAge) && vcAge >= 0 && vcAge <= 40;
    let vcLabel = "VC -";
    if (vcFresh) {
      if (rawVirtCap > 0) {
        vcLabel = `VC ${rawVirtCap}`;
      } else {
        const reasonToken = diag.vcReason || "vc_unknown";
        vcLabel = `VC 0(${reasonToken})`;
      }
    }
    const fullFlag = boolFlag(diag.targetFull);
    const neighborFlag = boolFlag(diag.neighborInventory);
    const regFlag = boolFlag(diag.registered);

    const actionbarLine =
      `Prism T${tier} | Queue ${queueSize} | Scan ${scanLabel} | Path ${pathMs} | Xfer ${transferLabel} | ${vcLabel} | Full ${fullFlag} | NbrInv ${neighborFlag} | Reg ${regFlag}`;

    return {
      actionbarLine,
      chatLines: [],
      contextKey: prismKey,
      contextLabel: "Prism",
    };
  },
};
