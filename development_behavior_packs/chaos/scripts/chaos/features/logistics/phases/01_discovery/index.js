// scripts/chaos/features/logistics/phases/01_discovery/index.js
import { ok } from "../../util/result.js";
import { runGraphMaintenance } from "./graphMaintenance.js";
import { runBeamJobs } from "./beamJobs.js";

export function createDiscoveryPhase() {
  return {
    name: "01_discovery",
    run(ctx) {
      runGraphMaintenance(ctx);
      runBeamJobs(ctx);
      return ok();
    },
  };
}

