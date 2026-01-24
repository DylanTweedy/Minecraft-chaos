// scripts/chaos/features/logistics/phases/05_arrival/index.js
import { ok } from "../../util/result.js";
import { handleArrivals } from "./arrivalEvents.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createArrivalPhase() {
  return {
    name: "05_arrival",
    run(ctx) {
      handleArrivals(ctx);
      const arrivals = ctx.insightCounts?.arrivals || 0;
      const spawns = ctx.insightCounts?.spawn_arrivals || 0;
      emitPhaseInsight(ctx, "05_arrival", `arrivals=${arrivals} spawns=${spawns}`);
      return ok();
    },
  };
}

