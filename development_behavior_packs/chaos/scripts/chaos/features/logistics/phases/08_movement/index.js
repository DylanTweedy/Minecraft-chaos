// scripts/chaos/features/logistics/phases/08_movement/index.js
import { ok } from "../../util/result.js";
import { advanceMovement } from "./movementSim.js";

export function createMovementPhase() {
  return {
    name: "08_movement",
    run(ctx) {
      advanceMovement(ctx);
      return ok();
    },
  };
}

