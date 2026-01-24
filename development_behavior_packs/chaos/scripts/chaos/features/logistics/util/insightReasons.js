// scripts/chaos/features/logistics/util/insightReasons.js
import { parsePrismKey } from "../network/graph/prismKeys.js";
import { makeBlockContextKey } from "../../../core/insight/context.js";
import { ReasonLabels } from "./insightReasonCodes.js";

const REASON_COOLDOWN_TICKS = 20;

export function prismKeyToContextKey(prismKey) {
  const parsed = parsePrismKey(prismKey);
  if (!parsed) return null;
  return makeBlockContextKey(parsed.dimId, parsed.x, parsed.y, parsed.z);
}

function recordPrismReason(ctx, prismKey, code, phaseName) {
  const state = ctx?.state;
  if (!state || !prismKey || !code) return;
  if (!state.insightReasons) state.insightReasons = { byPrism: new Map() };
  const byPrism = state.insightReasons.byPrism;
  if (!byPrism) return;
  let prismEntry = byPrism.get(prismKey);
  if (!prismEntry) {
    prismEntry = new Map();
    byPrism.set(prismKey, prismEntry);
  }
  const phaseKey = phaseName || "unknown";
  let phaseEntry = prismEntry.get(phaseKey);
  if (!phaseEntry) {
    phaseEntry = new Map();
    prismEntry.set(phaseKey, phaseEntry);
  }
  phaseEntry.set(code, (phaseEntry.get(code) || 0) + 1);
}

export function emitPrismReason(ctx, prismKey, code, text, opts = {}) {
  if (!ctx || typeof ctx.emitTrace !== "function") return false;
  const contextKey = prismKeyToContextKey(prismKey);
  if (!contextKey) return false;

  const { itemTypeId = "", dedupeSuffix = "", severity = "info", icon, phase } = opts;
  const dedupeKey = `reason:${code}:${prismKey}:${itemTypeId}:${dedupeSuffix}`;
  const nowTick = ctx.nowTick | 0;

  recordPrismReason(ctx, prismKey, code, phase || ctx.phaseName);

  if (!ctx._reasonCooldown) {
    ctx._reasonCooldown = new Map();
  }
  const lastTick = ctx._reasonCooldown.get(dedupeKey);
  if (typeof lastTick === "number" && nowTick - lastTick < REASON_COOLDOWN_TICKS) {
    return false;
  }

  ctx._reasonCooldown.set(dedupeKey, nowTick);

  ctx.emitTrace(null, "transfer", {
    text,
    category: "transfer",
    contextKey,
    dedupeKey,
    severity,
    icon,
  });

  return true;
}

export function getReasonLabel(code) {
  return ReasonLabels[code] || code || "unknown";
}
