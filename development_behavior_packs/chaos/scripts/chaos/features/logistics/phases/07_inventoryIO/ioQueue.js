// scripts/chaos/features/logistics/phases/07_inventoryIO/ioQueue.js
import { createOrb } from "../../state/orbs.js";
import { OrbModes, OrbStates } from "../../state/enums.js";
import {
  decrementInputSlotSafe,
  tryInsertAmountForContainer,
  tryInsertIntoContainerSlot,
  getInsertCapacityForSlot,
  isFurnaceBlock,
  getFurnaceSlots,
  getFurnaceInsertSlot,
} from "../../util/inventoryAdapter.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { getInventoryMutationGuard } from "../../util/inventoryMutationGuard.js";
import { emitTrace } from "../../../../core/insight/trace.js";
import { noteCooldown } from "../../../../core/insight/trace.js";
import { getPrismTier } from "../../config.js";

function removeOrb(ctx, orbId) {
  const orbs = ctx.state?.orbs || [];
  const orbsById = ctx.state?.orbsById;
  if (!orbsById || !orbsById.has(orbId)) return;
  const orb = orbsById.get(orbId);
  orbsById.delete(orbId);
  const idx = orbs.indexOf(orb);
  if (idx >= 0) orbs.splice(idx, 1);
}

export function processIoQueue(ctx) {
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const levelsManager = ctx.services?.levelsManager;
  const guard = getInventoryMutationGuard();
  if (!ctx.ioQueue) ctx.ioQueue = { extracts: [], inserts: [] };

  const extracts = ctx.ioQueue.extracts;
  const inserts = ctx.ioQueue.inserts;
  const spawnQueue = [];

  let extractProcessed = 0;
  const maxExtracts = ctx.budgets.state.ioExtracts | 0;

  while (extractProcessed < maxExtracts && extracts.length > 0) {
    const entry = extracts.shift();
    const intent = entry?.intent;
    if (!intent) continue;
    if (!intent.resolveKind || !intent.destPrismKey) {
      bumpCounter(ctx, "extract_without_resolve");
      emitPrismReason(
        ctx,
        intent?.sourcePrismKey || "unknown",
        ReasonCodes.EXTRACT_WITHOUT_RESOLVE,
        "Extract blocked (no resolve outcome)",
        { itemTypeId: intent?.itemTypeId }
      );
      continue;
    }
    const path = Array.isArray(intent.path) ? intent.path : null;
    if (!path || path.length < 2 || !intent.edgeToKey) {
      bumpCounter(ctx, "spawn_without_path");
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.SPAWN_WITHOUT_PATH,
        "Spawn blocked (missing path/edge)",
        { itemTypeId: intent.itemTypeId }
      );
      continue;
    }

    const containerInfo = cacheManager.resolveContainerInfoCached(intent.containerKey);
    const container = containerInfo?.container;
    if (!container) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.IO_EXTRACT_FAILED,
        "Extract: failed (container missing)",
        { itemTypeId: intent.itemTypeId }
      );
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.MUTATION_FAIL,
        "Mutation: extract failed",
        { itemTypeId: intent.itemTypeId }
      );
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const slot = intent.slot;
    if (isFurnaceBlock(containerInfo?.block)) {
      const outputSlot = getFurnaceSlots(containerInfo.block).output;
      if (slot !== outputSlot) {
        emitPrismReason(
          ctx,
          intent.sourcePrismKey,
          ReasonCodes.IO_EXTRACT_FAILED,
          "Extract: blocked (furnace output slot only)",
          { itemTypeId: intent.itemTypeId }
        );
        bumpCounter(ctx, "io_fail");
        continue;
      }
    }
    const stack = container.getItem(slot);
    if (!stack || stack.typeId !== intent.itemTypeId || stack.amount < intent.count) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.IO_EXTRACT_FAILED,
        "Extract: failed (item mismatch or insufficient)",
        { itemTypeId: intent.itemTypeId }
      );
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.MUTATION_FAIL,
        "Mutation: extract failed",
        { itemTypeId: intent.itemTypeId }
      );
      bumpCounter(ctx, "io_fail");
      continue;
    }

    guard.beginOrbSettlement(ctx, {
      phase: "07_inventoryIO",
      tag: "spawn_extract",
      prismKey: intent.sourcePrismKey,
      containerKey: intent.containerKey,
      itemTypeId: intent.itemTypeId,
      count: intent.count,
    });
    const decremented = decrementInputSlotSafe(container, slot, intent.count, {
      ctx,
      phase: "07_inventoryIO",
      tag: "spawn_extract",
      prismKey: intent.sourcePrismKey,
      containerKey: intent.containerKey,
    });
    guard.endOrbSettlement();
    if (!decremented) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.IO_EXTRACT_FAILED,
        "Extract: failed (mutation rejected)",
        { itemTypeId: intent.itemTypeId }
      );
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.MUTATION_FAIL,
        "Mutation: extract failed",
        { itemTypeId: intent.itemTypeId }
      );
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const resolveKind = intent.resolveKind || intent.mode;
    const edgeLen = Math.max(1, intent.edgeLength | 0);
    const orb = createOrb({
      itemTypeId: intent.itemTypeId,
      count: intent.count,
      mode: resolveKind === "drift" ? OrbModes.DRIFT : OrbModes.ATTUNED,
      state: OrbStates.IN_FLIGHT,
      currentPrismKey: intent.sourcePrismKey,
      sourcePrismKey: intent.sourcePrismKey,
      destPrismKey: intent.destPrismKey,
      destContainerKey: intent.destContainerKey || null,
      driftSinkKey: intent.driftSinkKey || null,
      path: Array.isArray(intent.path) ? intent.path.slice() : null,
      pathIndex: intent.pathIndex | 0,
      edgeFromKey: intent.edgeFromKey || intent.sourcePrismKey,
      edgeToKey: intent.edgeToKey,
      edgeEpoch: intent.edgeEpoch | 0,
      edgeLength: edgeLen,
      progress: 0,
      speed: Number.isFinite(intent.speed) ? intent.speed : 1,
      createdAtTick: ctx.nowTick | 0,
    });
    orb.sourceContainerKey = intent.containerKey || null;

    if (intent.sourcePrismKey && levelsManager && resolveBlockInfo) {
      const sourceInfo = resolveBlockInfo(intent.sourcePrismKey);
      const sourceBlock = sourceInfo?.block;
      const tier = sourceBlock ? getPrismTier(sourceBlock) : 1;
      const cooldownTicks = typeof levelsManager.getExportCooldownTicks === "function"
        ? levelsManager.getExportCooldownTicks(tier)
        : Math.max(1, Number(ctx.cfg?.perPrismIntervalTicks) || 5);
      const cooldownUntil = (ctx.nowTick | 0) + Math.max(1, cooldownTicks | 0);
      const cooldowns = ctx.state?.prismState?.exportCooldownByPrism;
      if (cooldowns) cooldowns.set(intent.sourcePrismKey, cooldownUntil);
      noteCooldown(intent.sourcePrismKey, cooldownUntil);
    }

    spawnQueue.push(orb);
    bumpCounter(ctx, "io_success");
    bumpCounter(ctx, "spawn_extract");
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.SPAWN_EXTRACT,
      `Spawn: extract ${intent.itemTypeId}`,
      { itemTypeId: intent.itemTypeId }
    );
    if (ctx.cfg?.debugEdgeLenTrace && typeof emitTrace === "function") {
      const speed = Number.isFinite(orb.speed) ? orb.speed : 1;
      const expectedTicks = speed > 0 ? Math.ceil(edgeLen / speed) : edgeLen;
      emitTrace(null, "transfer", {
        text: `[Transfer] Spawn ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${intent.destPrismKey || "none"} destC=${intent.destContainerKey || "unknown"} edgeLen=${edgeLen} speed=${speed.toFixed(3)} ticks=${expectedTicks}`,
        category: "transfer",
        dedupeKey: `transfer_spawn_${intent.sourcePrismKey}_${intent.itemTypeId}`,
      });
    }
    extractProcessed++;
  }

  if (!Array.isArray(ctx.spawnQueue)) ctx.spawnQueue = [];
  ctx.spawnQueue.push(...spawnQueue);

  let insertProcessed = 0;
  const maxInserts = ctx.budgets.state.ioInserts | 0;

  while (insertProcessed < maxInserts && inserts.length > 0) {
    const entry = inserts.shift();
    if (!entry) continue;
    const orbId = entry.orbId;
    const orb = ctx.state?.orbsById?.get(orbId);
    if (!orb) continue;
    if (orb.state !== OrbStates.AT_PRISM) {
      bumpCounter(ctx, "settle_without_inflight");
      emitPrismReason(
        ctx,
        orb.sourcePrismKey || entry.prismKey,
        ReasonCodes.SETTLE_WITHOUT_INFLIGHT,
        "Insert blocked (orb not settled)",
        { itemTypeId: entry.itemTypeId || orb?.itemTypeId }
      );
      continue;
    }
    const info = resolveBlockInfo ? resolveBlockInfo(entry.prismKey) : null;
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const itemTypeId = entry.itemTypeId || orb?.itemTypeId || "";
    const inventories = cacheManager.getPrismInventoriesCached(entry.prismKey, block, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) {
      emitPrismReason(
        ctx,
        entry.prismKey,
        ReasonCodes.IO_NO_INVENTORIES,
        "Insert: blocked (no inventories at destination prism)"
      );
      emitPrismReason(
        ctx,
        entry.prismKey,
        ReasonCodes.MUTATION_FAIL,
        "Mutation: insert failed",
        { itemTypeId }
      );
      bumpCounter(ctx, "io_fail");
      continue;
    }

    let inserted = false;
    let insertedContainerKey = null;
    let hasAnyCapacity = false;
    const targetContainerKey = orb.destContainerKey || null;
    for (const inv of inventories) {
      if (!inv?.container) continue;
      const isFurnace = isFurnaceBlock(inv.block);
      if (isFurnace) {
        const targetSlot = getFurnaceInsertSlot(itemTypeId);
        const capacity = getInsertCapacityForSlot(inv.container, targetSlot, itemTypeId);
        if (capacity > 0) hasAnyCapacity = true;
        const containerKey = getContainerKey(inv.block, inv.dim || dim);
        if (targetContainerKey && containerKey !== targetContainerKey) continue;
        guard.beginOrbSettlement(ctx, {
          phase: "07_inventoryIO",
          tag: "settlement_insert",
          prismKey: entry.prismKey,
          containerKey,
          itemTypeId,
          count: entry.count,
        });
        const ok = tryInsertIntoContainerSlot(inv.container, targetSlot, itemTypeId, entry.count, {
          ctx,
          phase: "07_inventoryIO",
          tag: "settlement_insert",
          prismKey: entry.prismKey,
          containerKey,
        });
        guard.endOrbSettlement();
        if (ok) {
          inserted = true;
          insertedContainerKey = containerKey;
          break;
        }
        continue;
      }
      const containerKey = getContainerKey(inv.entity || inv.block, inv.dim || dim);
      if (!containerKey) continue;
      if (targetContainerKey && containerKey !== targetContainerKey) continue;
      const capacity = cacheManager.getInsertCapacityCached(
        containerKey,
        inv.container,
        itemTypeId,
        { typeId: itemTypeId, amount: entry.count }
      );
      if (capacity > 0) hasAnyCapacity = true;
      guard.beginOrbSettlement(ctx, {
        phase: "07_inventoryIO",
        tag: "settlement_insert",
        prismKey: entry.prismKey,
        containerKey,
        itemTypeId,
        count: entry.count,
      });
      const ok = tryInsertAmountForContainer(inv, itemTypeId, entry.count, {
        ctx,
        phase: "07_inventoryIO",
        tag: "settlement_insert",
        prismKey: entry.prismKey,
        containerKey,
      });
      guard.endOrbSettlement();
      if (ok) {
        inserted = true;
        insertedContainerKey = containerKey;
        break;
      }
    }

    if (inserted) {
      removeOrb(ctx, orbId);
      bumpCounter(ctx, "io_success");
      bumpCounter(ctx, "settlement_insert");
      emitPrismReason(
        ctx,
        entry.prismKey,
        ReasonCodes.SETTLEMENT_INSERT,
        `Settle: insert ${itemTypeId}`,
        { itemTypeId }
      );
      if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
        emitTrace(null, "transfer", {
          text: `[Transfer] Settle ${entry.prismKey} item=${itemTypeId} dest=${insertedContainerKey || "unknown"} src=${orb?.sourceContainerKey || "unknown"}`,
          category: "transfer",
          dedupeKey: `transfer_settle_${entry.prismKey}_${itemTypeId}`,
        });
      }
    } else {
      const reasonCode = hasAnyCapacity ? ReasonCodes.IO_PRECHECK_FAILED : ReasonCodes.IO_DEST_FULL;
      const safeItemId = itemTypeId || "item";
      const reasonText = hasAnyCapacity
        ? `Insert: failed (precheck mismatch for ${safeItemId})`
        : `Insert: blocked (destination full for ${safeItemId})`;
      emitPrismReason(
        ctx,
        entry.prismKey,
        reasonCode,
        reasonText,
        { itemTypeId }
      );
      emitPrismReason(
        ctx,
        entry.prismKey,
        ReasonCodes.MUTATION_FAIL,
        "Mutation: insert failed",
        { itemTypeId }
      );
      orb.settlePending = false;
      bumpCounter(ctx, "io_fail");
    }

    insertProcessed++;
  }
}






