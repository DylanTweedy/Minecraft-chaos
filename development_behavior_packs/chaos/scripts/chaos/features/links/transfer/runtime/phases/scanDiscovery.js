// scripts/chaos/features/links/transfer/runtime/phases/scanDiscovery.js

import { ok, phaseStep } from "../helpers/result.js";

export function createScanDiscoveryPhase(deps) {
  return {
    name: "scanDiscovery",
    run(ctx) {
      const prismCount = Array.isArray(ctx?.prismKeys) ? ctx.prismKeys.length : 0;
      phaseStep(ctx, `scanDiscovery: ${prismCount} prisms`);

      return ok();
    },
  };
}

