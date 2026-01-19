// scripts/chaos/features/logistics/phases/05_arrival/index.js
import { ok } from "../../util/result.js";
import { handleArrivals } from "./arrivalEvents.js";

export function createArrivalPhase() {
  return {
    name: "05_arrival",
    run(ctx) {
      handleArrivals(ctx);
      return ok();
    },
  };
}

