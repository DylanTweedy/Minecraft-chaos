// scripts/chaos/features/logistics/util/phaseInsight.js

export function emitPhaseInsight(ctx, phaseName, text) {
  if (!ctx || typeof ctx.emitTrace !== "function") return;
  const interval = Math.max(1, Number(ctx.cfg?.insightReportIntervalTicks) || 20);
  if ((ctx.nowTick | 0) % interval !== 0) return;
  const bucket = Math.floor((ctx.nowTick | 0) / interval);
  const safePhase = String(phaseName || "phase");
  const payload = String(text || "");
  ctx.emitTrace(null, "transfer", {
    text: `[Phase] ${safePhase} ${payload}`.trim(),
    category: "transfer",
    dedupeKey: `phase_${safePhase}_${bucket}`,
  });
}
