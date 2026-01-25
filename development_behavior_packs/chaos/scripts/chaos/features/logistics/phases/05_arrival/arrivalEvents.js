// scripts/chaos/features/logistics/phases/05_arrival/arrivalEvents.js
import { OrbStates, OrbModes } from "../../state/enums.js";
import { notePrismXp } from "../../state/prisms.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { createOrb } from "../../state/orbs.js";
import { isFluxTypeId, tryRefineFluxInTransfer } from "../../../flux.js";
import { CRYSTALLIZER_ID, isPrismBlock } from "../../config.js";
import { addFluxForItem } from "../../../../crystallizer.js";

function removeOrb(ctx, orbId) {
  const orbs = ctx.state?.orbs || [];
  const orbsById = ctx.state?.orbsById;
  if (!orbsById || !orbsById.has(orbId)) return;
  const orb = orbsById.get(orbId);
  orbsById.delete(orbId);
  const idx = orbs.indexOf(orb);
  if (idx >= 0) orbs.splice(idx, 1);
}

export function handleArrivals(ctx) {
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const getFilterSetForBlock = ctx.services?.getFilterSetForBlock;
  const levelsManager = ctx.services?.levelsManager;
  const orbsById = ctx.state?.orbsById;
  const orbs = ctx.state?.orbs || [];

  const spawnQueue = Array.isArray(ctx.spawnQueue) ? ctx.spawnQueue : [];
  const arrivals = Array.isArray(ctx.arrivalQueue) ? ctx.arrivalQueue : [];

  for (const orb of spawnQueue) {
    if (!orb?.id) continue;
    if (orbsById && !orbsById.has(orb.id)) {
      orbs.push(orb);
      orbsById.set(orb.id, orb);
    }
  }
  if (Array.isArray(ctx.spawnQueue)) ctx.spawnQueue.length = 0;

  let processed = 0;
  const maxArrivals = ctx.budgets.state.arrivals | 0;

  const queuedForInsert = new Set();

  for (const event of arrivals) {
    if (processed >= maxArrivals) break;
    const orb = orbsById?.get(event.orbId);
    if (!orb) continue;

    const prismKey = event.prismKey || orb.currentPrismKey;
    if (!prismKey) continue;

    const info = resolveBlockInfo(prismKey);
    const prismBlock = info?.block;
    if (!prismBlock) continue;

    orb.state = OrbStates.AT_PRISM;
    orb.currentPrismKey = prismKey;
    orb.edgeFromKey = prismKey;
    orb.edgeToKey = null;
    orb.hops = (orb.hops | 0) + (event.spawn ? 0 : 1);
    orb.settlePending = false;

    if (isPrismBlock(prismBlock)) {
      notePrismXp(levelsManager, prismKey, prismBlock, orb.lastHandledPrismKey, orb);
    }

    if (prismBlock.typeId === CRYSTALLIZER_ID && isFluxTypeId(orb.itemTypeId)) {
      addFluxForItem(prismKey, orb.itemTypeId, orb.count);
      removeOrb(ctx, orb.id);
      bumpCounter(ctx, "flux_absorbed");
      processed++;
      continue;
    }

    if (isFluxTypeId(orb.itemTypeId)) {
      const speedScale = Math.max(0.1, (Number(orb.speed) || 0) * 20);
      const refined = tryRefineFluxInTransfer({
        prismBlock,
        itemTypeId: orb.itemTypeId,
        amount: orb.count,
        FX: ctx?.FX,
        speedScale,
      });
      if (refined?.items?.length) {
        const [primary, ...extras] = refined.items;
        if (primary?.typeId && primary?.amount > 0) {
          orb.itemTypeId = primary.typeId;
          orb.count = primary.amount | 0;
        }
        for (const entry of extras) {
          if (!entry?.typeId || (entry.amount | 0) <= 0) continue;
          const extraOrb = createOrb({
            itemTypeId: entry.typeId,
            count: entry.amount,
            mode: orb.mode,
            state: OrbStates.AT_PRISM,
            currentPrismKey: prismKey,
            sourcePrismKey: orb.sourcePrismKey,
            destPrismKey: orb.destPrismKey,
            destContainerKey: orb.destContainerKey,
            driftSinkKey: orb.driftSinkKey,
            path: Array.isArray(orb.path) ? orb.path.slice() : null,
            pathIndex: orb.pathIndex | 0,
            edgeFromKey: prismKey,
            edgeToKey: null,
            edgeEpoch: orb.edgeEpoch | 0,
            edgeLength: orb.edgeLength | 0,
            speed: Number.isFinite(orb.speed) ? orb.speed : 1,
            hops: orb.hops | 0,
            lastHandledPrismKey: orb.lastHandledPrismKey,
            createdAtTick: orb.createdAtTick | 0,
          });
          if (extraOrb?.id) {
            orbs.push(extraOrb);
            orbsById?.set(extraOrb.id, extraOrb);
          }
        }
      }
    }

    if (event.spawn) bumpCounter(ctx, "spawn_arrivals");
    bumpCounter(ctx, "arrivals");

    if (!ctx.ioQueue) ctx.ioQueue = { extracts: [], inserts: [] };

    if (orb.mode === OrbModes.ATTUNED && orb.destPrismKey === prismKey) {
      ctx.ioQueue.inserts.push({
        orbId: orb.id,
        prismKey,
        itemTypeId: orb.itemTypeId,
        count: orb.count,
        mode: orb.mode,
      });
      orb.settlePending = true;
      queuedForInsert.add(orb.id);
    } else if (orb.mode === OrbModes.DRIFT) {
      const sinkKey = orb.driftSinkKey || orb.destPrismKey;
      if (sinkKey && sinkKey === prismKey) {
        const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, prismBlock) : null;
        if (!filterSet || filterSet.size === 0) {
          ctx.ioQueue.inserts.push({
            orbId: orb.id,
            prismKey,
            itemTypeId: orb.itemTypeId,
            count: orb.count,
            mode: orb.mode,
          });
          orb.settlePending = true;
          queuedForInsert.add(orb.id);
        }
      }
    } else if (orb.mode === OrbModes.WALKING) {
      const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, prismBlock) : null;
      if (!filterSet || filterSet.size === 0) {
        ctx.ioQueue.inserts.push({
          orbId: orb.id,
          prismKey,
          itemTypeId: orb.itemTypeId,
          count: orb.count,
          mode: orb.mode,
        });
        orb.settlePending = true;
        queuedForInsert.add(orb.id);
      }
    }

    processed++;
  }

  if (Array.isArray(ctx.arrivalQueue)) ctx.arrivalQueue.length = 0;

  // Retry settlement for orbs still at prisms (IO failures from prior ticks).
  for (const orb of orbs) {
    if (!orb || orb.state !== OrbStates.AT_PRISM) continue;
    if (queuedForInsert.has(orb.id)) continue;
    const prismKey = orb.currentPrismKey;
    const info = resolveBlockInfo ? resolveBlockInfo(prismKey) : null;
    const prismBlock = info?.block;
    if (!prismBlock) continue;
    if (orb.mode === OrbModes.ATTUNED && orb.destPrismKey === prismKey) {
      ctx.ioQueue.inserts.push({
        orbId: orb.id,
        prismKey,
        itemTypeId: orb.itemTypeId,
        count: orb.count,
        mode: orb.mode,
      });
      orb.settlePending = true;
      queuedForInsert.add(orb.id);
    } else if (orb.mode === OrbModes.DRIFT) {
      const sinkKey = orb.driftSinkKey || orb.destPrismKey;
      if (sinkKey && sinkKey === prismKey) {
        const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, prismBlock) : null;
        if (!filterSet || filterSet.size === 0) {
          ctx.ioQueue.inserts.push({
            orbId: orb.id,
            prismKey,
            itemTypeId: orb.itemTypeId,
            count: orb.count,
            mode: orb.mode,
          });
          orb.settlePending = true;
          queuedForInsert.add(orb.id);
        }
      }
    } else if (orb.mode === OrbModes.WALKING) {
      const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, prismBlock) : null;
      if (!filterSet || filterSet.size === 0) {
        ctx.ioQueue.inserts.push({
          orbId: orb.id,
          prismKey,
          itemTypeId: orb.itemTypeId,
          count: orb.count,
          mode: orb.mode,
        });
        orb.settlePending = true;
        queuedForInsert.add(orb.id);
      }
    }
  }
}






