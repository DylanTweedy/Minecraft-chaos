// scripts/chaos/features/logistics/phases/09_fluxConversion/index.js
import { ok } from "../../util/result.js";
import { applyFluxConversion } from "./flux.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createFluxConversionPhase() {
  return {
    name: "09_fluxConversion",
    run(ctx) {
      applyFluxConversion(ctx);
      const converted = ctx.insightCounts?.flux_converted || 0;
      const refined = ctx.insightCounts?.flux_refined || 0;
      emitPhaseInsight(ctx, "09_fluxConversion", `converted=${converted} refined=${refined}`);
      return ok();
    },
  };
}

