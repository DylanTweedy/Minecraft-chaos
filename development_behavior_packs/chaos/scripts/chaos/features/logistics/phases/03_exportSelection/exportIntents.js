// scripts/chaos/features/logistics/phases/03_exportSelection/exportIntents.js
import { getContainerKey } from "../../keys.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { emitPrismReason } from "../../util/insightReasons.js";

export function buildExportIntents(ctx) {
  const cfg = ctx.cfg || {};
  const cacheManager = ctx.services?.cacheManager;
  const levelsManager = ctx.services?.levelsManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const isPrismBlock = ctx.services?.isPrismBlock;
  const prismKeys = Array.isArray(ctx.prismKeys) ? ctx.prismKeys : [];
  const intents = [];
  const maxSlots = Math.max(1, Number(cfg.scanCandidateSlotsPerInventory) || 16);
  const maxTypes = Math.max(1, Number(cfg.scanMaxItemTypesPerPrism) || 4);

  if (!cacheManager || !resolveBlockInfo || !isPrismBlock) {
    ctx.exportIntents = intents;
    return intents;
  }

  for (const prismKey of prismKeys) {
    const inflightCount = Array.isArray(ctx.state?.orbs) ? ctx.state.orbs.length : 0;
    if (inflightCount >= (ctx.cfg.maxInflightOrbs | 0)) {
      emitPrismReason(
        ctx,
        prismKey,
        "EXPORT_THROTTLED",
        "Export: throttled (caps/budget)"
      );
      bumpCounter(ctx, "throttles");
      break;
    }
    if (!ctx.budgets.take("exports", 1)) {
      emitPrismReason(
        ctx,
        prismKey,
        "EXPORT_THROTTLED",
        "Export: throttled (caps/budget)"
      );
      bumpCounter(ctx, "throttles");
      break;
    }

    const info = resolveBlockInfo(prismKey);
    const prismBlock = info?.block;
    const dim = info?.dim;
    if (!prismBlock || !isPrismBlock(prismBlock)) continue;

    const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) {
      emitPrismReason(
        ctx,
        prismKey,
        "EXPORT_NO_INVENTORIES",
        "Export: none (no adjacent inventories)"
      );
      continue;
    }

    let addedTypes = 0;
    for (let invIndex = 0; invIndex < inventories.length; invIndex++) {
      const inv = inventories[invIndex];
      if (!inv?.container) continue;
      const size = Math.max(0, Number(inv.container.size) || 0);
      const limit = Math.min(size, maxSlots);
      for (let slot = 0; slot < limit; slot++) {
        if (addedTypes >= maxTypes) break;
        const stack = inv.container.getItem(slot);
        if (!stack || stack.amount <= 0) continue;
        const planned = levelsManager?.getTransferAmount
          ? levelsManager.getTransferAmount(levelsManager.getNextInputLevel(prismKey), stack)
          : 1;
        const count = Math.max(1, Math.min(stack.amount, planned | 0));
        const containerKey = getContainerKey(inv.entity || inv.block, inv.dim || dim);
        if (!containerKey) continue;

        intents.push({
          id: `export_${prismKey}_${slot}_${ctx.nowTick}`,
          sourcePrismKey: prismKey,
          containerKey,
          slot,
          itemTypeId: stack.typeId,
          count,
          createdAtTick: ctx.nowTick | 0,
        });
        bumpCounter(ctx, "exported");
        addedTypes++;
      }
      if (addedTypes >= maxTypes) break;
    }
    if (addedTypes === 0) {
      emitPrismReason(
        ctx,
        prismKey,
        "EXPORT_NO_ITEMS",
        "Export: none (no items in scanned slots)"
      );
    }
  }

  ctx.exportIntents = intents;
  return intents;
}






