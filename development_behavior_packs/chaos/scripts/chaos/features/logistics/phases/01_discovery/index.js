// scripts/chaos/features/logistics/phases/01_discovery/index.js
import { ok } from "../../util/result.js";
import { runGraphMaintenance } from "./graphMaintenance.js";
import { runBeamJobs } from "./beamJobs.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createDiscoveryPhase() {
  return {
    name: "01_discovery",
    run(ctx) {
      const graphStats = runGraphMaintenance(ctx) || {};
      const beamStats = runBeamJobs(ctx) || {};
      const linkGraph = ctx.services?.linkGraph;
      const registry = ctx.services?.prismRegistry;
      const graphCounts = linkGraph?.getGraphStats?.() || { prisms: 0, edges: 0 };
      const prismCount = Array.isArray(registry?.resolvePrismKeys?.()) ? registry.resolvePrismKeys().length : graphCounts.prisms;
      const seedScanned = graphStats.seedScan?.scanned || 0;
      const seedDone = graphStats.seedScan?.completed ? "done" : "scan";
      const validated = graphStats.validateStats?.processed || 0;
      const rebuild = graphStats.rebuildStats?.processed || 0;
      const edgeChecks = graphStats.validateEdges?.processed || 0;
      const breaks = graphStats.breakCount || 0;
      const build = beamStats.buildProcessed || 0;
      const collapse = beamStats.collapseProcessed || 0;
      const sweep = ctx.insightCounts?.graph_sweep_marked || 0;
      const rejectWrong = ctx.insightCounts?.beam_reject_wrongblock || 0;
      const rejectNoEndpoint = ctx.insightCounts?.beam_reject_noendpoint || 0;
      const rejectNotStraight = ctx.insightCounts?.beam_reject_notstraight || 0;
      const rejectObstructed = ctx.insightCounts?.beam_reject_obstructed || 0;
      const rejectOther = ctx.insightCounts?.beam_reject_other || 0;
      emitPhaseInsight(
        ctx,
        "01_discovery",
        `prisms=${prismCount} edges=${graphCounts.edges} seed=${seedScanned}/${seedDone} validate=${validated} rebuild=${rebuild} edgeCheck=${edgeChecks} breaks=${breaks} beams=${build}/${collapse} sweep=${sweep} rej(wrong=${rejectWrong} noEnd=${rejectNoEndpoint} notStraight=${rejectNotStraight} obstruct=${rejectObstructed} other=${rejectOther})`
      );
      return ok();
    },
  };
}

