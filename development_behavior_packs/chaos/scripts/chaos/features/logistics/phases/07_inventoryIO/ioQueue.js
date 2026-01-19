// scripts/chaos/features/logistics/phases/07_inventoryIO/ioQueue.js
import { createOrb } from "../../state/orbs.js";
import { OrbModes, OrbStates } from "../../state/enums.js";
import { decrementInputSlotSafe, tryInsertAmountForContainer } from "../../util/inventoryAdapter.js";
import { bumpCounter } from "../../util/insightCounters.js";

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

    const containerInfo = cacheManager.resolveContainerInfoCached(intent.containerKey);
    const container = containerInfo?.container;
    if (!container) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const slot = intent.slot;
    const stack = container.getItem(slot);
    if (!stack || stack.typeId !== intent.itemTypeId || stack.amount < intent.count) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const decremented = decrementInputSlotSafe(container, slot, intent.count);
    if (!decremented) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const orb = createOrb({
      itemTypeId: intent.itemTypeId,
      count: intent.count,
      mode: intent.mode === "drift" ? OrbModes.DRIFT : intent.mode === "crucible" ? OrbModes.ATTUNED : OrbModes.ATTUNED,
      state: OrbStates.AT_PRISM,
      currentPrismKey: intent.sourcePrismKey,
      destPrismKey: intent.destPrismKey,
      driftSinkKey: intent.driftSinkKey || null,
      path: Array.isArray(intent.path) ? intent.path.slice() : null,
      pathIndex: 0,
      createdAtTick: ctx.nowTick | 0,
    });

    spawnQueue.push(orb);
    bumpCounter(ctx, "io_success");
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

    const info = resolveBlockInfo ? resolveBlockInfo(entry.prismKey) : null;
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    const inventories = cacheManager.getPrismInventoriesCached(entry.prismKey, block, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) {
      bumpCounter(ctx, "io_fail");
      continue;
    }

    let inserted = false;
    for (const inv of inventories) {
      if (!inv?.container) continue;
      if (tryInsertAmountForContainer(inv, entry.itemTypeId, entry.count)) {
        inserted = true;
        break;
      }
    }

    if (inserted) {
      removeOrb(ctx, orbId);
      bumpCounter(ctx, "io_success");
    } else {
      orb.settlePending = false;
      bumpCounter(ctx, "io_fail");
    }

    insertProcessed++;
  }
}






