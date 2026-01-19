// scripts/chaos/features/logistics/phases/01_discovery/graphMaintenance.js

export function runGraphMaintenance(ctx) {
  const cfg = ctx.cfg || {};
  const registry = ctx.services?.prismRegistry;
  const linkGraph = ctx.services?.linkGraph;
  const linkEvents = ctx.services?.linkEvents;
  const nowTick = ctx.nowTick | 0;

  if (registry?.seedScanTick) {
    const budget = Math.max(1, Number(cfg.prismSeedScanBlocksPerTick || 200) | 0);
    registry.seedScanTick(budget);
  }

  if (registry?.validateBudgeted) {
    const budget = Math.max(1, Number(cfg.prismValidationBudgetPerTick || 32) | 0);
    registry.validateBudgeted(budget, nowTick);
  }

  if (linkGraph?.rebuildDirtyBudgeted) {
    const budget = Math.max(1, Number(cfg.linkRebuildBudgetPerTick || 8) | 0);
    linkGraph.rebuildDirtyBudgeted(budget, nowTick);
  }

  if (linkGraph?.validateEdgesBudgeted) {
    const budget = Math.max(1, Number(cfg.linkValidateBudgetPerTick || 16) | 0);
    linkGraph.validateEdgesBudgeted(budget, nowTick);
  }

  if (typeof linkEvents?.drainBeamBreaks === "function" && linkGraph?.handleBeamBreakAt) {
    const breaks = linkEvents.drainBeamBreaks(Math.max(1, Number(cfg.beamBreaksPerTick || 32) | 0));
    for (const b of breaks) {
      linkGraph.handleBeamBreakAt(b.dimId, { x: b.x, y: b.y, z: b.z });
    }
  }
}

