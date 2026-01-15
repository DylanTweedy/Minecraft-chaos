// scripts/chaos/features/links/transfer/runtime/phases/updateBeams.js
import { ok, phaseStep } from "../helpers/result.js";
import { tickBeamJobs } from "../../../beam/jobs.js";

export function createUpdateBeamsPhase(deps) {
  const cfg = deps?.cfg || {};
  const world = deps?.world;

  return {
    name: "updateBeams",
    run(ctx) {
      const buildBudget = Math.max(0, Number(cfg.beamBuildBlocksPerTick || 8) | 0);
      const collapseBudget = Math.max(0, Number(cfg.beamCollapseBlocksPerTick || 8) | 0);
      tickBeamJobs(world, { buildBudget, collapseBudget });
      phaseStep(ctx, "updateBeams");
      return ok();
    },
  };
}
