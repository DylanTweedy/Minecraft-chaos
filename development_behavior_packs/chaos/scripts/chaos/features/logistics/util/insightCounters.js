// scripts/chaos/features/logistics/util/insightCounters.js
import { noteCount } from "../../../core/insight/perf.js";

export function bumpCounter(ctx, key, delta = 1) {
  if (!ctx || !key) return;
  if (!ctx.insightCounts) ctx.insightCounts = Object.create(null);
  const current = ctx.insightCounts[key] || 0;
  ctx.insightCounts[key] = current + (delta | 0);
  noteCount("transfer", key, delta);
}

export function formatCounters(counts) {
  if (!counts) return "";
  const parts = [];
  for (const [k, v] of Object.entries(counts)) {
    parts.push(`${k}:${v}`);
  }
  return parts.join(" ");
}

