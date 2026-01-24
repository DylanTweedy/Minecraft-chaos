// scripts/chaos/features/logistics/phases/06_departure/departureEvents.js
import { OrbModes, OrbStates } from "../../state/enums.js";
import { notePrismXp, getDriftCursor, setDriftCursor } from "../../state/prisms.js";
import { findPathBetweenKeys } from "../../util/routing.js";
import { resolveDrift } from "../04_destinationResolve/resolveDrift.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { getPrismTier, PRISM_SPEED_BOOST_BASE, PRISM_SPEED_BOOST_PER_TIER } from "../../config.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";

function assignEdge(orb, linkGraph, fromKey, toKey) {
  const edge = linkGraph.getEdgeBetweenKeys(fromKey, toKey);
  if (!edge) return false;
  orb.edgeFromKey = fromKey;
  orb.edgeToKey = toKey;
  orb.edgeEpoch = edge.epoch | 0;
  orb.edgeLength = edge.length | 0;
  orb.progress = 0;
  orb.state = OrbStates.IN_FLIGHT;
  return true;
}

function ensurePathForOrb(ctx, orb, opts = {}) {
  const linkGraph = ctx.services?.linkGraph;
  if (!linkGraph || !orb?.currentPrismKey || !orb?.destPrismKey) return null;
  if (!opts.force && Array.isArray(orb.path) && orb.path.length > 1) return orb.path;
  const path = findPathBetweenKeys(
    linkGraph,
    orb.currentPrismKey,
    orb.destPrismKey,
    ctx.cfg.maxVisitedPerSearch || 120
  );
  if (!path || path.length < 2) return null;
  orb.path = path;
  orb.pathIndex = 0;
  return path;
}

function recomputePathForOrb(ctx, orb, prismKey) {
  if (!orb || !prismKey) return null;
  orb.currentPrismKey = prismKey;
  return ensurePathForOrb(ctx, orb, { force: true });
}

function peekNextHopFromPath(ctx, orb, prismKey) {
  if (!orb || !prismKey || !orb.destPrismKey) return null;
  let path = Array.isArray(orb.path) ? orb.path : null;
  let idx = orb.pathIndex | 0;
  if (!Array.isArray(path) || path.length < 2) {
    path = ensurePathForOrb(ctx, orb);
    idx = orb.pathIndex | 0;
  }
  if (!Array.isArray(path) || path.length < 2) return null;
  if (path[idx] !== prismKey) {
    path = ensurePathForOrb(ctx, orb);
    idx = orb.pathIndex | 0;
    if (!Array.isArray(path) || path.length < 2) return null;
  }
  const nextIdx = idx + 1;
  const nextKey = path[nextIdx];
  if (!nextKey) return null;
  return { nextKey, nextIdx, path };
}

function pickWalkingNeighbor(ctx, orb) {
  const linkGraph = ctx.services?.linkGraph;
  if (!linkGraph) return null;
  const neighbors = linkGraph.getNeighbors(orb.currentPrismKey) || [];
  if (neighbors.length === 0) return null;
  const cursor = getDriftCursor(ctx.state?.prismState, orb.currentPrismKey) | 0;
  const idx = Math.abs(cursor) % neighbors.length;
  const next = neighbors[idx]?.key || null;
  setDriftCursor(ctx.state?.prismState, orb.currentPrismKey, cursor + 1);
  return next;
}

function isDriftSinkStillViable(ctx, orb) {
  const sinkKey = orb?.driftSinkKey;
  if (!sinkKey) return false;
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const getFilterSetForBlock = ctx.services?.getFilterSetForBlock;
  const isPrismBlock = ctx.services?.isPrismBlock;
  const info = resolveBlockInfo ? resolveBlockInfo(sinkKey) : null;
  const block = info?.block;
  const dim = info?.dim;
  if (!block || !dim) return false;
  if (typeof isPrismBlock === "function" && !isPrismBlock(block)) return false;
  const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, block) : null;
  if (filterSet && filterSet.size > 0) return false;
  const inventories = cacheManager?.getPrismInventoriesCached(sinkKey, block, dim);
  if (!Array.isArray(inventories) || inventories.length === 0) return false;
  for (const inv of inventories) {
    const container = inv?.container;
    if (!container) continue;
    const containerKey = getContainerKey(inv.entity || inv.block, inv.dim || dim);
    if (!containerKey) continue;
    const capacity = cacheManager.getInsertCapacityCached(
      containerKey,
      container,
      orb.itemTypeId,
      { typeId: orb.itemTypeId, amount: orb.count }
    );
    if (capacity > 0) return true;
  }
  return false;
}

function reassignDriftSink(ctx, orb, prismKey) {
  const drift = resolveDrift(ctx, {
    sourcePrismKey: prismKey,
    itemTypeId: orb.itemTypeId,
    count: orb.count,
  });
  if (!drift) return null;
  orb.driftSinkKey = drift.destPrismKey;
  orb.destPrismKey = drift.destPrismKey;
  orb.path = Array.isArray(drift.path) ? drift.path.slice() : null;
  orb.pathIndex = 0;
  bumpCounter(ctx, "drift_recomputed");
  return drift;
}

function startWalking(ctx, orb, opts = {}) {
  if (!orb || orb.mode === OrbModes.WALKING) return;
  const prismKey = opts.prismKey || orb.currentPrismKey;
  const prevMode = orb.mode;
  orb.mode = OrbModes.WALKING;
  orb.destPrismKey = null;
  orb.driftSinkKey = null;
  orb.path = null;
  orb.pathIndex = 0;
  orb.walkingIndex = (orb.walkingIndex | 0) + 1;
  if (opts.reasonCode && prismKey) {
    emitPrismReason(
      ctx,
      prismKey,
      opts.reasonCode,
      opts.text || "Walking fallback (no route)",
      { itemTypeId: orb.itemTypeId }
    );
  }
  bumpCounter(ctx, "walking_started");
  if (prevMode === OrbModes.DRIFT) {
    bumpCounter(ctx, "walking_from_drift");
    bumpCounter(ctx, "drift_walkers");
  } else {
    bumpCounter(ctx, "walking_from_attuned");
  }
}

export function handleDepartures(ctx) {
  const linkGraph = ctx.services?.linkGraph;
  const levelsManager = ctx.services?.levelsManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const orbs = ctx.state?.orbs || [];
  const nowTick = ctx.nowTick | 0;
  const cooldowns = ctx.state?.prismState?.exportCooldownByPrism;

  if (!linkGraph) return;

  if (!ctx.ioQueue) ctx.ioQueue = { extracts: [], inserts: [] };

  const intents = Array.isArray(ctx.departureIntents) ? ctx.departureIntents : [];
  const extractedThisTick = new Set();
  for (const intent of intents) {
    if (!ctx.budgets.take("ioExtracts", 1)) break;
    const sourceKey = intent.sourcePrismKey;
    if (cooldowns && sourceKey) {
      const cooldownUntil = cooldowns.get(sourceKey) | 0;
      if (cooldownUntil > nowTick) {
        bumpCounter(ctx, "export_cooldown_active");
        emitPrismReason(
          ctx,
          sourceKey,
          ReasonCodes.EXPORT_THROTTLED,
          `Export: cooldown (${cooldownUntil - nowTick})`,
          { itemTypeId: intent.itemTypeId }
        );
        continue;
      }
    }
    if (sourceKey && extractedThisTick.has(sourceKey)) {
      bumpCounter(ctx, "export_cooldown_active");
      emitPrismReason(
        ctx,
        sourceKey,
        ReasonCodes.EXPORT_THROTTLED,
        "Export: cooldown (per-prism, 1 per tick)",
        { itemTypeId: intent.itemTypeId }
      );
      continue;
    }
    if (!intent.destPrismKey || !intent.resolveKind) {
      bumpCounter(ctx, "extract_without_resolve");
      emitPrismReason(
        ctx,
        sourceKey,
        ReasonCodes.EXTRACT_WITHOUT_RESOLVE,
        "Extract blocked (no resolve outcome)",
        { itemTypeId: intent.itemTypeId }
      );
      continue;
    }
    const path = Array.isArray(intent.path) ? intent.path : null;
    if (!path || path.length < 2) {
      bumpCounter(ctx, "spawn_without_path");
      emitPrismReason(
        ctx,
        sourceKey,
        ReasonCodes.SPAWN_WITHOUT_PATH,
        "Spawn blocked (missing path)",
        { itemTypeId: intent.itemTypeId }
      );
      continue;
    }
    const nextHop = path[1];
    const edge = linkGraph.getEdgeBetweenKeys(sourceKey, nextHop);
    if (!edge) {
      bumpCounter(ctx, "spawn_without_path");
      emitPrismReason(
        ctx,
        sourceKey,
        ReasonCodes.SPAWN_WITHOUT_PATH,
        "Spawn blocked (edge missing)",
        { itemTypeId: intent.itemTypeId }
      );
      continue;
    }
    const sourceInfo = resolveBlockInfo ? resolveBlockInfo(sourceKey) : null;
    const prismBlock = sourceInfo?.block;
    const tier = prismBlock ? getPrismTier(prismBlock) : 1;
    const baseStepTicks = levelsManager?.getOrbStepTicks
      ? levelsManager.getOrbStepTicks(tier)
      : Math.max(1, Number(ctx.cfg.orbStepTicks) || 16);
    const minTravel = Math.max(1, Number(ctx.cfg.minTravelTicks) || 5);
    const minStepTicks = Math.max(1, Number(ctx.cfg.minOrbStepTicks) || 1);
    const stepTicks = Math.max(baseStepTicks, minTravel, minStepTicks);
    const speed = 1 / Math.max(1, stepTicks);
    const edgeLen = Math.max(1, edge.length | 0);

    ctx.ioQueue.extracts.push({
      intent: {
        ...intent,
        edgeFromKey: sourceKey,
        edgeToKey: nextHop,
        edgeLength: edgeLen,
        edgeEpoch: edge.epoch | 0,
        speed,
        pathIndex: 0,
        stepTicks,
      },
    });
    bumpCounter(ctx, "departures_intended");
    if (sourceKey) extractedThisTick.add(sourceKey);
  }
  ctx.departureIntents = [];

  let processed = 0;
  const maxDepartures = ctx.budgets.state.departures | 0;

  for (const orb of orbs) {
    if (processed >= maxDepartures) break;
    if (!orb || orb.state !== OrbStates.AT_PRISM) continue;
    if (orb.settlePending) continue;

    const prismKey = orb.currentPrismKey;
    if (!prismKey) continue;

    const prismInfo = resolveBlockInfo ? resolveBlockInfo(prismKey) : null;
    const prismBlock = prismInfo?.block;
    notePrismXp(levelsManager, prismKey, prismBlock, orb.lastHandledPrismKey, orb);

    let nextHop = null;
    let hopMeta = null;

    if (orb.mode === OrbModes.ATTUNED) {
      hopMeta = peekNextHopFromPath(ctx, orb, prismKey);
      if (!hopMeta) {
        hopMeta = null;
        startWalking(ctx, orb, {
          prismKey,
          reasonCode: ReasonCodes.WALK_NO_ATTUNED,
          text: `Walking fallback (attuned intent blocked)`,
        });
      }
    } else if (orb.mode === OrbModes.DRIFT) {
      if (!isDriftSinkStillViable(ctx, orb)) {
        const drift = reassignDriftSink(ctx, orb, prismKey);
        if (!drift) {
          startWalking(ctx, orb, {
            prismKey,
            reasonCode: ReasonCodes.WALK_DRIFT_LOST,
            text: `Walking fallback (drift sink lost)`,
          });
        }
      }
      if (orb.mode === OrbModes.DRIFT) {
        hopMeta = peekNextHopFromPath(ctx, orb, prismKey);
        if (!hopMeta) {
          hopMeta = null;
          startWalking(ctx, orb, {
            prismKey,
            reasonCode: ReasonCodes.WALK_DRIFT_ROUTE,
            text: `Walking fallback (drift route missing)`,
          });
        }
      }
    }

    if (orb.mode === OrbModes.WALKING) {
      nextHop = pickWalkingNeighbor(ctx, orb);
    } else if (hopMeta) {
      nextHop = hopMeta.nextKey;
    }

    if (!nextHop) continue;

    if (!assignEdge(orb, linkGraph, prismKey, nextHop)) {
      bumpCounter(ctx, "missing_edge");
      emitPrismReason(
        ctx,
        prismKey,
        ReasonCodes.EDGE_MISSING_PRECHECK,
        "Departure: edge missing (reroute/precheck)",
        { itemTypeId: orb.itemTypeId }
      );
      let rerouteHop = null;

      if (orb.mode === OrbModes.ATTUNED) {
        recomputePathForOrb(ctx, orb, prismKey);
        hopMeta = peekNextHopFromPath(ctx, orb, prismKey);
        rerouteHop = hopMeta?.nextKey || null;
        if (!rerouteHop) {
          startWalking(ctx, orb, {
            prismKey,
            reasonCode: ReasonCodes.WALK_EDGE_FAIL,
            text: "Walking fallback (attuned edge missing)",
          });
        }
      } else if (orb.mode === OrbModes.DRIFT) {
        if (orb.driftSinkKey) {
          recomputePathForOrb(ctx, orb, prismKey);
          hopMeta = peekNextHopFromPath(ctx, orb, prismKey);
          rerouteHop = hopMeta?.nextKey || null;
        }
        if (!rerouteHop && orb.mode === OrbModes.DRIFT) {
          const drift = reassignDriftSink(ctx, orb, prismKey);
          if (drift) {
            hopMeta = peekNextHopFromPath(ctx, orb, prismKey);
            rerouteHop = hopMeta?.nextKey || null;
          }
        }
        if (!rerouteHop && orb.mode === OrbModes.DRIFT) {
          startWalking(ctx, orb, {
            prismKey,
            reasonCode: ReasonCodes.WALK_EDGE_FAIL,
            text: "Walking fallback (drift edge missing)",
          });
        }
      } else if (orb.mode === OrbModes.WALKING) {
        rerouteHop = pickWalkingNeighbor(ctx, orb);
      }

      if (!rerouteHop || !assignEdge(orb, linkGraph, prismKey, rerouteHop)) {
        continue;
      }
      nextHop = rerouteHop;
      if (hopMeta?.nextKey !== rerouteHop) {
        hopMeta = null;
      }
    }

    if (hopMeta?.nextIdx != null && Array.isArray(hopMeta.path)) {
      orb.pathIndex = hopMeta.nextIdx;
      orb.path = hopMeta.path;
    }

    if (prismBlock) {
      const tier = getPrismTier(prismBlock);
      const baseStepTicks = levelsManager?.getOrbStepTicks
        ? levelsManager.getOrbStepTicks(tier)
        : Math.max(1, Number(ctx.cfg.orbStepTicks) || 16);
      const minTravel = Math.max(1, Number(ctx.cfg.minTravelTicks) || 5);
      const minStepTicks = Math.max(1, Number(ctx.cfg.minOrbStepTicks) || 1);
      const stepTicks = Math.max(baseStepTicks, minTravel, minStepTicks);
      const baseSpeed = 1 / Math.max(1, stepTicks);
      const currentSpeed = Number.isFinite(orb.speed) ? orb.speed : 0;
      const boost = 1 + PRISM_SPEED_BOOST_BASE + ((Math.max(1, tier) - 1) * PRISM_SPEED_BOOST_PER_TIER);
      const maxSpeed = 1 / Math.max(1, minStepTicks);
      // Always boost multiplicatively when passing through prisms, capped to max speed.
      const boosted = Math.max(currentSpeed, baseSpeed) * Math.max(1, boost);
      orb.speed = Math.min(maxSpeed, boosted);
    }

    bumpCounter(ctx, "departures");
    bumpCounter(ctx, `departed_${orb.mode}`);
    processed++;
  }
}
