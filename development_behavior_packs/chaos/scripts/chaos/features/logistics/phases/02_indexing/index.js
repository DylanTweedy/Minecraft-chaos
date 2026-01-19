// scripts/chaos/features/logistics/phases/02_indexing/index.js
import { ok } from "../../util/result.js";
import { rebuildFilterIndex } from "./filterIndex.js";
import { buildEndpointIndex } from "./endpointIndex.js";

export function createIndexingPhase() {
  return {
    name: "02_indexing",
    run(ctx) {
      if (!ctx.indexes) ctx.indexes = {};
      rebuildFilterIndex(ctx);
      buildEndpointIndex(ctx);
      return ok();
    },
  };
}

