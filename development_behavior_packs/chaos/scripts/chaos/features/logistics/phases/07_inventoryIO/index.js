// scripts/chaos/features/logistics/phases/07_inventoryIO/index.js
import { ok } from "../../util/result.js";
import { processIoQueue } from "./ioQueue.js";

export function createInventoryIOPhase() {
  return {
    name: "07_inventoryIO",
    run(ctx) {
      processIoQueue(ctx);
      return ok();
    },
  };
}

