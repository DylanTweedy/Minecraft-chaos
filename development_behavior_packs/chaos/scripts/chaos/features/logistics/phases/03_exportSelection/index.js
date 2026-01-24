// scripts/chaos/features/logistics/phases/03_exportSelection/index.js
import { ok } from "../../util/result.js";
import { buildExportIntents } from "./exportIntents.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createExportSelectionPhase() {
  return {
    name: "03_exportSelection",
    run(ctx) {
      buildExportIntents(ctx);
      const intents = Array.isArray(ctx.exportIntents) ? ctx.exportIntents.length : 0;
      const prisms = Array.isArray(ctx.prismKeys) ? ctx.prismKeys.length : 0;
      const scanned = ctx.insightCounts?.export_prisms_scanned || 0;
      const inventories = ctx.insightCounts?.export_inventories_found || 0;
      const slots = ctx.insightCounts?.export_slots_scanned || 0;
      const items = ctx.insightCounts?.export_items_seen || 0;
      const cursor = ctx.state?.prismState?.exportScanCursor | 0;
      const throttled = ctx.insightCounts?.export_scan_throttled || 0;
      const noInv = ctx.insightCounts?.export_no_inventories || 0;
      const noItems = ctx.insightCounts?.export_no_items || 0;
      emitPhaseInsight(
        ctx,
        "03_exportSelection",
        `prisms=${prisms} scanned=${scanned} cursor=${cursor} inv=${inventories} slots=${slots} items=${items} intents=${intents} throttled=${throttled} noInv=${noInv} noItems=${noItems}`
      );
      return ok();
    },
  };
}

