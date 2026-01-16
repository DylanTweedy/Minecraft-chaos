// scripts/chaos/features/links/transfer/persistence/inflight.js
import { MAX_STEPS } from "../config.js";
import { loadInflight, saveInflight } from "./storage.js";
import { resolveBlockInfoStatic } from "../utils.js";
import { getAttachedInventoryInfo } from "../util/inventoryAdapter.js";
import { getContainerKey, getContainerKeyFromInfo } from "../keys.js";

function sanitizeInflightEntry(entry) {
  try {
    if (!entry || typeof entry !== "object") return null;
    const mode = typeof entry.mode === "string" ? entry.mode : null;
    const isHybrid = typeof mode === "string" && mode.startsWith("hybrid");
    if (isHybrid && !entry.mode) entry.mode = "hybrid_drift";
    if (typeof entry.dimId !== "string") return null;
    if (typeof entry.itemTypeId !== "string") return null;
    if (isHybrid) {
      if (!entry.sourcePrismKey || typeof entry.sourcePrismKey !== "string") {
        if (typeof entry.currentPrismKey === "string") {
          entry.sourcePrismKey = entry.currentPrismKey;
        } else {
          return null;
        }
      }
      if (!entry.currentPrismKey || typeof entry.currentPrismKey !== "string") {
        entry.currentPrismKey = entry.sourcePrismKey;
      }
      if (!entry.destPrismKey || typeof entry.destPrismKey !== "string") {
        return null;
      }
      if (!Array.isArray(entry.path)) entry.path = [];
    } else {
      if (!Array.isArray(entry.path) || entry.path.length === 0) return null;
      if (!entry.outputKey || typeof entry.outputKey !== "string") return null;
    }
    if (!Number.isFinite(entry.stepIndex)) entry.stepIndex = 0;
    if (!Number.isFinite(entry.ticksUntilStep)) entry.ticksUntilStep = 1;
    if (!Number.isFinite(entry.stepTicks)) entry.stepTicks = entry.ticksUntilStep;
    if (!Number.isFinite(entry.amount)) entry.amount = 1;
    entry.amount = Math.max(1, entry.amount | 0);
    if (typeof entry.containerKey !== "string") entry.containerKey = null;
    if (entry.prismKey && typeof entry.prismKey !== "string") entry.prismKey = null;
    if (!entry.startPos || !Number.isFinite(entry.startPos.x)) entry.startPos = null;
    if (!Array.isArray(entry.countedPrisms)) entry.countedPrisms = [];
    return entry;
  } catch {
    return null;
  }
}

export function loadInflightStateFromWorld(world, inflight, cfg) {
  const raw = loadInflight(world);
  inflight.length = 0;
  for (const entry of raw) {
    const clean = sanitizeInflightEntry(entry);
    if (!clean) continue;
    if (clean.path.length > MAX_STEPS) continue;
    if (clean.ticksUntilStep < 1) clean.ticksUntilStep = cfg.orbStepTicks;
    if (clean.stepTicks < 1) clean.stepTicks = cfg.orbStepTicks;
    if (!clean.containerKey && clean.outputKey) {
      const outInfo = resolveBlockInfoStatic(world, clean.outputKey);
      if (outInfo?.block) {
        const cInfo = getAttachedInventoryInfo(outInfo.block, outInfo.dim);
        clean.containerKey = getContainerKeyFromInfo(cInfo);
      }
    }
    inflight.push(clean);
  }
}

export function persistInflightStateToWorld(world, inflight) {
  saveInflight(world, inflight);
}
