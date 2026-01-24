// scripts/chaos/features/logistics/phases/08_movement/index.js
import { ok } from "../../util/result.js";
import { advanceMovement } from "./movementSim.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createMovementPhase() {
  return {
    name: "08_movement",
    run(ctx) {
      advanceMovement(ctx);
      const arrivals = ctx.insightCounts?.arrivals_movement || 0;
      const inflight = Array.isArray(ctx.state?.orbs)
        ? ctx.state.orbs.filter((o) => o?.state === "in_flight").length
        : 0;
      emitPhaseInsight(ctx, "08_movement", `inflight=${inflight} arrivals=${arrivals}`);
      return ok();
    },
  };
}

