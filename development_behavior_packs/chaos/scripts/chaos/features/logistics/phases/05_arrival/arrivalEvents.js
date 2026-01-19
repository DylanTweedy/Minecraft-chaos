// scripts/chaos/features/logistics/phases/05_arrival/arrivalEvents.js
import { OrbStates, OrbModes } from "../../state/enums.js";
import { notePrismXp } from "../../state/prisms.js";
import { bumpCounter } from "../../util/insightCounters.js";

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
    arrivals.push({ orbId: orb.id, prismKey: orb.currentPrismKey, spawn: true });
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
    orb.hops = (orb.hops | 0) + (event.spawn ? 0 : 1);
    orb.settlePending = false;

    notePrismXp(levelsManager, prismKey, prismBlock, orb.lastHandledPrismKey, orb);

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
    } else if (orb.mode === OrbModes.DRIFT || orb.mode === OrbModes.WALKING) {
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
    } else if (orb.mode === OrbModes.DRIFT || orb.mode === OrbModes.WALKING) {
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






