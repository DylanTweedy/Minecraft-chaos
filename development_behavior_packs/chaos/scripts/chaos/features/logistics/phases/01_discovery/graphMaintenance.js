// scripts/chaos/features/logistics/phases/01_discovery/graphMaintenance.js
import { bumpCounter } from "../../util/insightCounters.js";

export function runGraphMaintenance(ctx) {
  const cfg = ctx.cfg || {};
  const registry = ctx.services?.prismRegistry;
  const linkGraph = ctx.services?.linkGraph;
  const linkEvents = ctx.services?.linkEvents;
  const nowTick = ctx.nowTick | 0;

  let seedScan = null;
  if (registry?.seedScanTick) {
    const budget = Math.max(1, Number(cfg.prismSeedScanBlocksPerTick || 200) | 0);
    seedScan = registry.seedScanTick(budget);
  }

  let validateStats = null;
  if (registry?.validateBudgeted) {
    const budget = Math.max(1, Number(cfg.prismValidationBudgetPerTick || 32) | 0);
    validateStats = registry.validateBudgeted(budget, nowTick);
  }

  const prismKeys = registry?.resolvePrismKeys?.() || [];
  const graphStats = linkGraph?.getGraphStats?.() || { prisms: 0, edges: 0 };
  if (graphStats.edges === 0 && prismKeys.length > 0 && linkGraph?.markNodeDirty) {
    const state = ctx.state?.prismState;
    const cursor = state?.graphRebuildCursor | 0;
    const budget = Math.max(1, Number(cfg.linkRebuildBudgetPerTick || 8) | 0);
    const count = Math.min(prismKeys.length, budget);
    for (let i = 0; i < count; i++) {
      const key = prismKeys[(cursor + i) % prismKeys.length];
      linkGraph.markNodeDirty(key);
    }
    if (state) state.graphRebuildCursor = (cursor + count) % prismKeys.length;
    bumpCounter(ctx, "graph_sweep_marked");
  }

  let rebuildStats = null;
  if (linkGraph?.setDiagnosticsCollector) {
    linkGraph.setDiagnosticsCollector((entry) => {
      const code = String(entry?.code || "Other");
      bumpCounter(ctx, `beam_reject_${code.toLowerCase()}`);
    });
  }
  if (linkGraph?.rebuildDirtyBudgeted) {
    const budget = Math.max(1, Number(cfg.linkRebuildBudgetPerTick || 8) | 0);
    rebuildStats = linkGraph.rebuildDirtyBudgeted(budget, nowTick);
  }
  if (linkGraph?.setDiagnosticsCollector) {
    linkGraph.setDiagnosticsCollector(null);
  }

  let validateEdges = null;
  if (linkGraph?.validateEdgesBudgeted) {
    const budget = Math.max(1, Number(cfg.linkValidateBudgetPerTick || 16) | 0);
    validateEdges = linkGraph.validateEdgesBudgeted(budget, nowTick);
  }

  let breakCount = 0;
  if (typeof linkEvents?.drainBeamBreaks === "function" && linkGraph?.handleBeamBreakAt) {
    const breaks = linkEvents.drainBeamBreaks(Math.max(1, Number(cfg.beamBreaksPerTick || 32) | 0));
    for (const b of breaks) {
      linkGraph.handleBeamBreakAt(b.dimId, { x: b.x, y: b.y, z: b.z });
    }
    breakCount = breaks.length;
  }

  return {
    seedScan,
    validateStats,
    rebuildStats,
    validateEdges,
    breakCount,
  };
}

