// scripts/chaos/features/logistics/phases/06_departure/index.js
import { ok } from "../../util/result.js";
import { handleDepartures } from "./departureEvents.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createDeparturePhase() {
  return {
    name: "06_departure",
    run(ctx) {
      handleDepartures(ctx);
      const departures = ctx.insightCounts?.departures || 0;
      const missing = ctx.insightCounts?.missing_edge || 0;
      emitPhaseInsight(ctx, "06_departure", `departures=${departures} missingEdge=${missing}`);
      return ok();
    },
  };
}

