// scripts/chaos/features/logistics/phases/03_exportSelection/exportIntents.js
import { getContainerKey } from "../../keys.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { isFurnaceBlock, getFurnaceSlots, getInventoryContainer, getRandomItemFromInventories } from "../../util/inventoryAdapter.js";

export function buildExportIntents(ctx) {
  const cfg = ctx.cfg || {};
  const cacheManager = ctx.services?.cacheManager;
  const levelsManager = ctx.services?.levelsManager;
  const getPrismTier = ctx.services?.getPrismTier;
  const getFilterSetForBlock = ctx.services?.getFilterSetForBlock;
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

  function describeAdjacentBlocks(prismBlock, dim) {
    if (!prismBlock || !dim) return "";
    const loc = prismBlock.location;
    if (!loc) return "";
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    function getComponentFlags(block) {
      if (!block) return "";
      let invComp = false;
      let containerComp = false;
      try {
        invComp = !!block.getComponent?.("minecraft:inventory") || !!block.getComponent?.("inventory");
        containerComp = !!block.getComponent?.("minecraft:container");
      } catch (e) {
        // ignore
      }
      let compList = "";
      try {
        const comps = block.getComponents?.() || [];
        const ids = comps.map((c) => c?.typeId || c?.id).filter(Boolean);
        if (ids.length > 0) compList = ids.join(",");
      } catch (e) {
        // ignore
      }
      const flags = [];
      if (invComp) flags.push("inv");
      if (containerComp) flags.push("ctr");
      if (compList) flags.push(compList);
      return flags.length > 0 ? `{${flags.join("|")}}` : "";
    }

    const parts = [];
    for (const d of dirs) {
      const b = dim.getBlock({ x: loc.x + d.x, y: loc.y + d.y, z: loc.z + d.z });
      if (!b) {
        parts.push("none");
        continue;
      }
      const hasInv = !!getInventoryContainer(b);
      const compFlags = getComponentFlags(b);
      parts.push(`${b.typeId}${hasInv ? "*" : ""}${compFlags}`);
    }
    return parts.join(",");
  }

  const totalPrisms = prismKeys.length;
  const maxScan = Math.max(1, Number(cfg.maxPrismsScannedPerTick) || totalPrisms || 1);
  const scanCount = Math.min(totalPrisms, maxScan);
  const state = ctx.state?.prismState;
  const cursor = state?.exportScanCursor | 0;
  if (scanCount < totalPrisms) bumpCounter(ctx, "export_scan_throttled");

  for (let i = 0; i < scanCount; i++) {
    const prismKey = prismKeys[(cursor + i) % totalPrisms];
    bumpCounter(ctx, "export_prisms_scanned");
    const inflightCount = Array.isArray(ctx.state?.orbs)
      ? ctx.state.orbs.filter((o) => o?.state === "in_flight").length
      : 0;
    if (inflightCount >= (ctx.cfg.maxInflightOrbs | 0)) {
      emitPrismReason(
        ctx,
        prismKey,
        ReasonCodes.THROTTLED,
        "Export: throttled (caps/budget)"
      );
      bumpCounter(ctx, "throttles");
      break;
    }
    if (!ctx.budgets.take("exports", 1)) {
      emitPrismReason(
        ctx,
        prismKey,
        ReasonCodes.THROTTLED,
        "Export: throttled (caps/budget)"
      );
      bumpCounter(ctx, "throttles");
      break;
    }

    const info = resolveBlockInfo(prismKey);
    const prismBlock = info?.block;
    const dim = info?.dim;
    if (!prismBlock || !isPrismBlock(prismBlock)) continue;

    const prismFilterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, prismBlock) : null;

    const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) {
      bumpCounter(ctx, "export_no_inventories");
      const adj = describeAdjacentBlocks(prismBlock, dim);
      const diag = ctx.state?.inventoryDiag?.byPrism?.get(prismKey);
      const diagParts = [];
      if (diag) {
        for (const [k, v] of diag.entries()) {
          diagParts.push(`${k}=${v}`);
        }
      }
      const diagText = diagParts.length > 0 ? ` reasons=${diagParts.join(",")}` : "";
      const edgeCount = ctx.services?.linkGraph?.getGraphStats?.().edges || 0;
      if (edgeCount === 0) {
        emitPrismReason(
          ctx,
          prismKey,
          ReasonCodes.NO_EDGE_GRAPH,
          "Export: none (no graph edges)"
        );
      }
      emitPrismReason(
        ctx,
        prismKey,
        ReasonCodes.NO_ADJACENT_INV,
        adj
          ? `Export: none (no adjacent inventories) adj=${adj}${diagText}`
          : `Export: none (no adjacent inventories)${diagText}`
      );
      continue;
    }
    bumpCounter(ctx, "export_inventories_found", inventories.length | 0);

    let addedTypes = 0;
    let slotsCounted = false;
    const seenTypes = new Set();
    const slotListProvider = (inv, limit, size) => {
      if (isFurnaceBlock(inv?.block)) {
        return [getFurnaceSlots(inv.block).output];
      }
      const total = Math.max(0, size | 0);
      if (total <= 0) return [];
      const cap = Math.min(total, Math.max(1, limit | 0));
      if (cap >= total) return Array.from({ length: total }, (_, i) => i);
      // Randomized scan to avoid biasing toward early rows/slots.
      const slots = Array.from({ length: total }, (_, i) => i);
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = slots[i];
        slots[i] = slots[j];
        slots[j] = tmp;
      }
      return slots.slice(0, cap);
    };
    while (addedTypes < maxTypes) {
      const picked = getRandomItemFromInventories(inventories, prismFilterSet, {
        maxSlotsPerInventory: maxSlots,
        slotListProvider,
        slotFilter: (_inv, _slot, item) => !seenTypes.has(item?.typeId),
      });
      if (!picked || !picked.stack) break;
      bumpCounter(ctx, "export_inventories_found");
      if (!slotsCounted && Number.isFinite(picked.scannedSlots)) {
        bumpCounter(ctx, "export_slots_scanned", picked.scannedSlots | 0);
        slotsCounted = true;
      }
      const stack = picked.stack;
      if (seenTypes.has(stack.typeId)) break;
      bumpCounter(ctx, "export_items_seen");
      const tier = typeof getPrismTier === "function" ? getPrismTier(prismBlock) : null;
      const level = Number.isFinite(tier) ? tier : levelsManager?.getNextInputLevel?.(prismKey) || 1;
      const planned = levelsManager?.getTransferAmount
        ? levelsManager.getTransferAmount(level, stack)
        : 1;
      const count = Math.max(1, Math.min(stack.amount, planned | 0));
      const containerKey = getContainerKey(picked.entity || picked.block, picked.dim || dim);
      if (!containerKey) break;
      intents.push({
        id: `export_${prismKey}_${picked.slot}_${ctx.nowTick}`,
        sourcePrismKey: prismKey,
        containerKey,
        slot: picked.slot,
        itemTypeId: stack.typeId,
        count,
        createdAtTick: ctx.nowTick | 0,
      });
      seenTypes.add(stack.typeId);
      bumpCounter(ctx, "export_intents");
      addedTypes++;
    }
    if (addedTypes === 0) {
      bumpCounter(ctx, "export_no_items");
      emitPrismReason(
        ctx,
        prismKey,
        ReasonCodes.INV_EMPTY,
        "Export: none (no items in scanned slots)"
      );
    }
  }

  if (state) {
    state.exportScanCursor = totalPrisms > 0 ? (cursor + scanCount) % totalPrisms : 0;
  }

  ctx.exportIntents = intents;
  return intents;
}






