// scripts/chaos/features/logistics/phases/10_persistInsight/insightReport.js
import { emitTrace } from "../../../../core/insight/trace.js";
import { formatCounters } from "../../util/insightCounters.js";

export function publishInsight(ctx) {
  const interval = Math.max(1, Number(ctx.cfg?.insightReportIntervalTicks) || 20);
  if ((ctx.nowTick | 0) % interval !== 0) return;
  const text = formatCounters(ctx.insightCounts);
  if (!text) return;
  emitTrace(null, "transfer", {
    text: `[Transfer] ${text}`,
    category: "transfer",
    dedupeKey: `transfer_summary_${ctx.nowTick | 0}`,
  });
}

