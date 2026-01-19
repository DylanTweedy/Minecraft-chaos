// scripts/chaos/features/logistics/phases/10_persistInsight/index.js
import { ok } from "../../util/result.js";
import { persistState } from "./persist.js";
import { publishInsight } from "./insightReport.js";

export function createPersistInsightPhase() {
  return {
    name: "10_persistInsight",
    run(ctx) {
      persistState(ctx);
      publishInsight(ctx);
      return ok();
    },
  };
}

