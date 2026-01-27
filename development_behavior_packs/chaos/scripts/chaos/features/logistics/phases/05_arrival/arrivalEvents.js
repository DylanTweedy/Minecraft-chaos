// scripts/chaos/features/logistics/phases/05_arrival/arrivalEvents.js
import { OrbStates, OrbModes } from "../../state/enums.js";
import { notePrismXp } from "../../state/prisms.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { createOrb } from "../../state/orbs.js";
import { getFluxTypeForTier, isFluxTypeId, tryRefineFluxInTransfer } from "../../../flux.js";
import { CRUCIBLE_ID, CRYSTALLIZER_ID, FOUNDRY_ID, TRANSPOSER_ID, COLLECTOR_ID, isPrismBlock } from "../../config.js";
import { addFluxForItem } from "../../../../crystallizer.js";
import { dropItemAt } from "../../util/positions.js";
import { resolveCrystallizer } from "../04_destinationResolve/resolveCrystallizer.js";
import { resolveFoundry } from "../04_destinationResolve/resolveFoundry.js";
import { resolveCollector } from "../04_destinationResolve/resolveCollector.js";
import { resolveTransposer } from "../04_destinationResolve/resolveTransposer.js";
import { getCrucibleValue } from "../../systems/crucibleValues.js";
import { addFoundryFlux } from "../../systems/foundryState.js";
import { addCollectorChargeForBlock } from "../../collector.js";
import { parseKey } from "../../keys.js";
import { getLinkedKey } from "../../../transposer/pairs.js";
import { addSharedCharge, getChargeLimits, getSharedStateKey, getSharedStateSnapshot } from "../../../transposer/state.js";
import { getFluxTier } from "../../../flux.js";

function removeOrb(ctx, orbId) {
  const orbs = ctx.state?.orbs || [];
  const orbsById = ctx.state?.orbsById;
  if (!orbsById || !orbsById.has(orbId)) return;
  const orb = orbsById.get(orbId);
  orbsById.delete(orbId);
  const idx = orbs.indexOf(orb);
  if (idx >= 0) orbs.splice(idx, 1);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function resolveFluxEndpoint(ctx, intent) {
  const options = shuffleInPlace([
    resolveFoundry,
    resolveCrystallizer,
    resolveCollector,
    resolveTransposer,
  ]);
  for (const fn of options) {
    const resolved = fn(ctx, intent);
    if (resolved?.path?.length) return resolved;
  }
  return null;
}

function setTransposerState(block, state) {
  try {
    const perm = block?.permutation;
    if (!perm) return;
    const cur = perm.getState("chaos:transposer_state");
    if (cur === state) return;
    block.setPermutation(perm.withState("chaos:transposer_state", state));
  } catch {
    // ignore
  }
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

    if (prismBlock.typeId === CRUCIBLE_ID) {
      const baseValue = getCrucibleValue(orb.itemTypeId);
      const lensCount = Math.max(0, orb.edgeMeta?.lensCount | 0);
      const bonusPerLens = Math.max(0, Number(ctx.cfg?.crucibleLensBonusPerLens) || 0);
      const bonusMax = Math.max(0, Number(ctx.cfg?.crucibleLensBonusMax) || 0);
      const bonus = Math.min(bonusMax, lensCount * bonusPerLens);
      const multiplier = Math.max(1, 1 + bonus);
      const totalValue = Math.max(1, Math.floor(baseValue * (orb.count | 0) * multiplier));
      const fluxTypeId = getFluxTypeForTier(1);
      const fluxOrb = createOrb({
        itemTypeId: fluxTypeId,
        count: totalValue,
        mode: OrbModes.FLUX,
        state: OrbStates.AT_PRISM,
        currentPrismKey: prismKey,
        sourcePrismKey: prismKey,
        destPrismKey: null,
        destContainerKey: null,
        driftSinkKey: null,
        path: null,
        pathIndex: 0,
        edgeFromKey: prismKey,
        edgeToKey: null,
        edgeEpoch: 0,
        edgeLength: 0,
        speed: Number.isFinite(orb.speed) ? orb.speed : 1,
        hops: orb.hops | 0,
        lastHandledPrismKey: prismKey,
        createdAtTick: orb.createdAtTick | 0,
      });

      const resolved = resolveFluxEndpoint(ctx, {
        sourcePrismKey: prismKey,
        itemTypeId: fluxTypeId,
        count: orb.count,
      });
      if (resolved?.path?.length) {
        fluxOrb.destPrismKey = resolved.destPrismKey;
        fluxOrb.path = resolved.path.slice();
        fluxOrb.pathIndex = 0;
      }

      if (fluxOrb?.id) {
        orbs.push(fluxOrb);
        orbsById?.set(fluxOrb.id, fluxOrb);
      }
      removeOrb(ctx, orb.id);
      if (ctx.services?.emitTrace) {
        ctx.services.emitTrace(null, "crucible", {
          text: `[Crucible] Convert ${orb.itemTypeId} x${orb.count} → flux ${totalValue}`,
          category: "crucible",
          dedupeKey: `crucible_convert_${prismKey}_${orb.itemTypeId}_${ctx.nowTick | 0}`,
          contextKey: prismKey,
        });
      }
      bumpCounter(ctx, "crucible_converted");
      processed++;
      continue;
    }

    if (prismBlock.typeId === CRYSTALLIZER_ID && isFluxTypeId(orb.itemTypeId)) {
      addFluxForItem(prismKey, orb.itemTypeId, orb.count);
      removeOrb(ctx, orb.id);
      bumpCounter(ctx, "flux_absorbed");
      processed++;
      continue;
    }

    if (prismBlock.typeId === FOUNDRY_ID) {
      const baseValue = getCrucibleValue(orb.itemTypeId) * Math.max(1, orb.count | 0);
      const lensCount = Math.max(0, orb.edgeMeta?.lensCount | 0);
      const bonusPerLens = Math.max(0, Number(ctx.cfg?.foundryLensBonusPerLens) || 0);
      const bonusMax = Math.max(0, Number(ctx.cfg?.foundryLensBonusMax) || 0);
      const bonus = Math.min(bonusMax, lensCount * bonusPerLens);
      const multiplier = Math.max(1, 1 + bonus);
      const value = Math.max(1, Math.floor(baseValue * multiplier));
      const maxFlux = Math.max(0, Number(ctx.cfg?.foundryMaxFluxStored) || 0);
      const newFlux = addFoundryFlux(prismKey, value, maxFlux);
      if (ctx.services?.emitTrace) {
        ctx.services.emitTrace(null, "foundry", {
          text: `[Foundry] Buffer +${value} (total=${newFlux}) from ${orb.itemTypeId} x${orb.count}`,
          category: "foundry",
          dedupeKey: `foundry_buffer_${prismKey}_${orb.itemTypeId}_${ctx.nowTick | 0}`,
          contextKey: prismKey,
        });
      }
      removeOrb(ctx, orb.id);
      bumpCounter(ctx, "foundry_buffered");
      processed++;
      continue;
    }

    if (prismBlock.typeId === COLLECTOR_ID && isFluxTypeId(orb.itemTypeId)) {
      const added = addCollectorChargeForBlock(prismBlock, orb.itemTypeId, orb.count);
      if (added > 0) {
        removeOrb(ctx, orb.id);
        bumpCounter(ctx, "collector_charged");
        processed++;
        continue;
      }
    }

    if (prismBlock.typeId === TRANSPOSER_ID && isFluxTypeId(orb.itemTypeId)) {
      const linkedKey = getLinkedKey(prismKey);
      const stateKey = getSharedStateKey(prismKey, linkedKey);
      if (stateKey) {
        const tier = Math.max(1, getFluxTier(orb.itemTypeId) || 1);
        const added = addSharedCharge(stateKey, tier * Math.max(1, orb.count | 0));
        if (added <= 0) {
          bumpCounter(ctx, "transposer_full");
          // Leave orb to continue through normal flux handling.
        } else {
          const snapshot = getSharedStateSnapshot(stateKey);
          const charge = Math.max(0, snapshot?.charge | 0);
          const limits = getChargeLimits();
          const maxCharge = Math.max(0, limits?.max | 0);
          const desiredState = linkedKey
            ? (charge > maxCharge ? 3 : charge > 0 ? 2 : 1)
            : 0;
          setTransposerState(prismBlock, desiredState);
          if (linkedKey) {
            const parsed = parseKey(linkedKey);
            const dim = parsed ? ctx.world?.getDimension?.(parsed.dimId) : null;
            const linkedBlock = dim?.getBlock?.({ x: parsed.x, y: parsed.y, z: parsed.z });
            if (linkedBlock?.typeId === TRANSPOSER_ID) {
              setTransposerState(linkedBlock, desiredState);
            }
          }
          removeOrb(ctx, orb.id);
          bumpCounter(ctx, "transposer_charged");
          processed++;
          continue;
        }
      }
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






