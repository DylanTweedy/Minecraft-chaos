// scripts/chaos/features/logistics/phases/10_persistInsight/index.js
import { ok } from "../../util/result.js";
import { persistState } from "./persist.js";
import { publishInsight } from "./insightReport.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createPersistInsightPhase() {
  return {
    name: "10_persistInsight",
    run(ctx) {
      persistState(ctx);
      publishInsight(ctx);
      const orbs = Array.isArray(ctx.state?.orbs) ? ctx.state.orbs.length : 0;
      emitPhaseInsight(ctx, "10_persistInsight", `persisted_orbs=${orbs}`);
      return ok();
    },
  };
}

