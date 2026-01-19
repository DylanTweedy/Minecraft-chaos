// scripts/chaos/features/logistics/phases/03_exportSelection/index.js
import { ok } from "../../util/result.js";
import { buildExportIntents } from "./exportIntents.js";

export function createExportSelectionPhase() {
  return {
    name: "03_exportSelection",
    run(ctx) {
      buildExportIntents(ctx);
      return ok();
    },
  };
}

