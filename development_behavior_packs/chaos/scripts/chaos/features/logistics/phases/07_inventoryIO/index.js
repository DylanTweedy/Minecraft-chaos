// scripts/chaos/features/logistics/phases/07_inventoryIO/index.js
import { ok } from "../../util/result.js";
import { processIoQueue } from "./ioQueue.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createInventoryIOPhase() {
  return {
    name: "07_inventoryIO",
    run(ctx) {
      processIoQueue(ctx);
      const extracts = ctx.insightCounts?.departures_intended || 0;
      const okCount = ctx.insightCounts?.io_success || 0;
      const failCount = ctx.insightCounts?.io_fail || 0;
      emitPhaseInsight(ctx, "07_inventoryIO", `extracts=${extracts} ok=${okCount} fail=${failCount}`);
      return ok();
    },
  };
}

