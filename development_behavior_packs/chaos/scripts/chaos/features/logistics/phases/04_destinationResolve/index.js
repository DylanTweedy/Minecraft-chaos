// scripts/chaos/features/logistics/phases/04_destinationResolve/index.js
import { ok } from "../../util/result.js";
import { resolveDepartureIntents } from "./resolver.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createDestinationResolvePhase() {
  return {
    name: "04_destinationResolve",
    run(ctx) {
      resolveDepartureIntents(ctx);
      const departures = Array.isArray(ctx.departureIntents) ? ctx.departureIntents.length : 0;
      const intents = ctx.insightCounts?.resolve_intents || 0;
      const attuned = ctx.insightCounts?.resolved_attuned || 0;
      const crucible = ctx.insightCounts?.resolved_crucible || 0;
      const drift = ctx.insightCounts?.resolved_drift || 0;
      const none = ctx.insightCounts?.resolved_none || 0;
      emitPhaseInsight(
        ctx,
        "04_destinationResolve",
        `intents=${intents} departures=${departures} a=${attuned} c=${crucible} d=${drift} n=${none}`
      );
      return ok();
    },
  };
}






