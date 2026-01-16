// scripts/chaos/features/links/transfer/runtime/phases/handleBeamBreaks.js
import { ok, phaseStep } from "../../util/result.js";

export function createHandleBeamBreaksPhase(deps) {
  const services = deps?.services || {};
  const getBeamBreaks = deps?.getBeamBreaks;

  return {
    name: "handleBeamBreaks",
    run(ctx) {
      const linkGraph = (ctx?.services && ctx.services.linkGraph) || services.linkGraph;
      const takeBreaks = getBeamBreaks || ctx?.getBeamBreaks;
      if (typeof takeBreaks !== "function" || !linkGraph) return ok();

      const breaks = takeBreaks();
      for (const b of breaks) {
        linkGraph.handleBeamBreakAt(b.dimId, { x: b.x, y: b.y, z: b.z });
      }

      phaseStep(ctx, "handleBeamBreaks");
      return ok();
    },
  };
}
