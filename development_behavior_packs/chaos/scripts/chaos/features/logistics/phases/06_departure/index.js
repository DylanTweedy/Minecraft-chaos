// scripts/chaos/features/logistics/phases/06_departure/index.js
import { ok } from "../../util/result.js";
import { handleDepartures } from "./departureEvents.js";

export function createDeparturePhase() {
  return {
    name: "06_departure",
    run(ctx) {
      handleDepartures(ctx);
      return ok();
    },
  };
}

