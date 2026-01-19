// scripts/chaos/features/logistics/util/insightReasons.js
import { parsePrismKey } from "../network/graph/prismKeys.js";
import { makeBlockContextKey } from "../../../core/insight/context.js";

const REASON_COOLDOWN_TICKS = 20;

export function prismKeyToContextKey(prismKey) {
  const parsed = parsePrismKey(prismKey);
  if (!parsed) return null;
  return makeBlockContextKey(parsed.dimId, parsed.x, parsed.y, parsed.z);
}

export function emitPrismReason(ctx, prismKey, code, text, opts = {}) {
  if (!ctx || typeof ctx.emitTrace !== "function") return false;
  const contextKey = prismKeyToContextKey(prismKey);
  if (!contextKey) return false;

  const { itemTypeId = "", dedupeSuffix = "", severity = "info", icon } = opts;
  const dedupeKey = `reason:${code}:${prismKey}:${itemTypeId}:${dedupeSuffix}`;
  const nowTick = ctx.nowTick | 0;

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
