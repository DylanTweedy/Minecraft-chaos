// scripts/chaos/features/logistics/phases/10_persistInsight/insightReport.js
import { emitTrace } from "../../../../core/insight/trace.js";
import { getReasonLabel, prismKeyToContextKey } from "../../util/insightReasons.js";

function formatRoutingSummary(counts = {}) {
  const attuned = counts.resolved_attuned || 0;
  const crucible = counts.resolved_crucible || 0;
  const foundry = counts.resolved_foundry || 0;
  const drift = counts.resolved_drift || 0;
  const none = counts.resolved_none || 0;
  if (!attuned && !crucible && !foundry && !drift && !none) return "";
  return `resolve a=${attuned} c=${crucible} f=${foundry} d=${drift} n=${none}`;
}

function formatIoSummary(counts = {}) {
  const ok = counts.io_success || 0;
  const fail = counts.io_fail || 0;
  const spawn = counts.spawn_extract || 0;
  const settle = counts.settlement_insert || 0;
  const noInflight = counts.settle_without_inflight || 0;
  const noResolve = counts.extract_without_resolve || 0;
  const noPath = counts.spawn_without_path || 0;
  const tooFast = counts.settle_too_fast || 0;
  if (!ok && !fail && !spawn && !settle && !noInflight && !noResolve && !noPath && !tooFast) return "";
  const parts = [`ok=${ok}`, `fail=${fail}`];
  if (spawn) parts.push(`spawn=${spawn}`);
  if (settle) parts.push(`settle=${settle}`);
  if (noInflight) parts.push(`noInflight=${noInflight}`);
  if (noResolve) parts.push(`noResolve=${noResolve}`);
  if (noPath) parts.push(`noPath=${noPath}`);
  if (tooFast) parts.push(`tooFast=${tooFast}`);
  return `io ${parts.join(" ")}`;
}

function formatEdgeSummary(counts = {}) {
  const missing = counts.missing_edge || 0;
  const dropped = counts.dropped_on_break || 0;
  if (!missing && !dropped) return "";
  return `edges missing=${missing} drop=${dropped}`;
}

function formatThroughputSummary(counts = {}, inflight = 0) {
  const arrivals = counts.arrivals_movement || 0;
  const departures = counts.departures || 0;
  const intents = counts.export_intents || 0;
  if (!inflight && !intents && !departures && !arrivals) return "";
  return `inflight=${inflight} intents=${intents} dep=${departures} arr=${arrivals}`;
}

function formatMutationHealth(counts = {}, state, nowTick, interval) {
  const detected = counts.illegal_mutation_detected || 0;
  const blocked = counts.illegal_mutation_blocked || 0;
  if (detected || blocked) {
    return `orb-only WARN detected=${detected} blocked=${blocked}`;
  }
  const lastViolation = state?.mutationGuard?.lastViolationTick || 0;
  if ((nowTick | 0) - (lastViolation | 0) >= interval) {
    return "orb-only OK";
  }
  return "";
}

function formatPrismReasonSummary(phaseMap) {
  if (!phaseMap || typeof phaseMap.entries !== "function") return "";
  let topCode = null;
  let topCount = 0;
  let topPhase = "";
  for (const [phaseName, codeMap] of phaseMap.entries()) {
    if (!codeMap || typeof codeMap.entries !== "function") continue;
    for (const [code, count] of codeMap.entries()) {
      if ((count | 0) > topCount) {
        topCode = code;
        topCount = count | 0;
        topPhase = phaseName || "";
      }
    }
  }
  if (!topCode) return "";
  const label = getReasonLabel(topCode);
  return `${topPhase}:${label}=${topCount}`;
}

export function publishInsight(ctx) {
  const interval = Math.max(1, Number(ctx.cfg?.insightReportIntervalTicks) || 20);
  if ((ctx.nowTick | 0) % interval !== 0) return;
  if (typeof emitTrace !== "function") return;

  const inflight = Array.isArray(ctx.state?.orbs)
    ? ctx.state.orbs.filter((o) => o?.state === "in_flight").length
    : 0;
  const routingText = formatRoutingSummary(ctx.insightCounts);
  const ioText = formatIoSummary(ctx.insightCounts);
  const edgeText = formatEdgeSummary(ctx.insightCounts);
  const throughputText = formatThroughputSummary(ctx.insightCounts, inflight);
  const mutationHealth = formatMutationHealth(ctx.insightCounts, ctx.state, ctx.nowTick, interval);

  const parts = [];
  if (throughputText) parts.push(throughputText);
  if (routingText) parts.push(routingText);
  if (ioText) parts.push(ioText);
  if (edgeText) parts.push(edgeText);
  if (mutationHealth) parts.push(mutationHealth);

  if (parts.length === 0) return;

  emitTrace(null, "transfer", {
    text: `[Transfer] ${parts.join(" | ")}`,
    category: "transfer",
    dedupeKey: `transfer_summary_${ctx.nowTick | 0}`,
  });

  emitTrace(null, "transfer", {
    text: `[Transfer] Summary ${parts.join(" | ")}`,
    category: "transfer",
    dedupeKey: `transfer_summary_line_${ctx.nowTick | 0}`,
  });

  const reasonState = ctx.state?.insightReasons;
  const byPrism = reasonState?.byPrism;
  if (byPrism && byPrism.size > 0) {
    const bucket = Math.floor((ctx.nowTick | 0) / interval);
    for (const [prismKey, phaseMap] of byPrism.entries()) {
      const summary = formatPrismReasonSummary(phaseMap);
      if (!summary) continue;
      const contextKey = prismKeyToContextKey(prismKey);
      emitTrace(null, "transfer", {
        text: `[Transfer] Prism ${prismKey} ${summary}`,
        category: "transfer",
        contextKey,
        dedupeKey: `transfer_prism_reason_${prismKey}_${bucket}`,
      });
    }
    byPrism.clear();
  }
}

