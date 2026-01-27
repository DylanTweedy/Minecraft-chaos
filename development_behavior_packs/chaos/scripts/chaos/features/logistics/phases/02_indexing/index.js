// scripts/chaos/features/logistics/phases/02_indexing/index.js
import { ok } from "../../util/result.js";
import { rebuildFilterIndex } from "./filterIndex.js";
import { buildEndpointIndex } from "./endpointIndex.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createIndexingPhase() {
  return {
    name: "02_indexing",
    run(ctx) {
      if (!ctx.indexes) ctx.indexes = {};
      const filterIndex = rebuildFilterIndex(ctx);
      const endpoints = buildEndpointIndex(ctx);
      const filterKeyCount = filterIndex?._index?.size || 0;
      let filterPrismCount = 0;
      if (filterIndex?._index) {
        for (const set of filterIndex._index.values()) {
          filterPrismCount += set?.size || 0;
        }
      }
      const crucibles = endpoints?.crucible?.length || 0;
      const crystallizers = endpoints?.crystallizer?.length || 0;
      const foundries = endpoints?.foundry?.length || 0;
      emitPhaseInsight(
        ctx,
        "02_indexing",
        `filters=${filterKeyCount} links=${filterPrismCount} crucible=${crucibles} crystallizer=${crystallizers} foundry=${foundries}`
      );
      return ok();
    },
  };
}

