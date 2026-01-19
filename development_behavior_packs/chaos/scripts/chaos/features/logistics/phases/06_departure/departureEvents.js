// scripts/chaos/features/logistics/phases/06_departure/departureEvents.js
import { OrbModes, OrbStates } from "../../state/enums.js";
import { notePrismXp, getDriftCursor, setDriftCursor } from "../../state/prisms.js";
import { findPathBetweenKeys } from "../../util/routing.js";
import { resolveDrift } from "../04_destinationResolve/resolveDrift.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { getPrismTier } from "../../config.js";

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

function ensurePathForOrb(ctx, orb) {
  const linkGraph = ctx.services?.linkGraph;
  if (!linkGraph || !orb.destPrismKey) return null;
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

function selectDriftFallback(ctx, orb, prismKey) {
  const drift = resolveDrift(ctx, {
    sourcePrismKey: prismKey,
    itemTypeId: orb.itemTypeId,
    count: orb.count,
  });
  if (drift) {
    orb.mode = OrbModes.DRIFT;
    orb.driftSinkKey = drift.destPrismKey;
    orb.path = drift.path;
    orb.pathIndex = 0;
    return drift.path?.[1] || null;
  }
  orb.mode = OrbModes.WALKING;
  bumpCounter(ctx, "drift_walkers");
  return null;
}

export function handleDepartures(ctx) {
  const linkGraph = ctx.services?.linkGraph;
  const levelsManager = ctx.services?.levelsManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const orbs = ctx.state?.orbs || [];

  if (!linkGraph) return;

  if (!ctx.ioQueue) ctx.ioQueue = { extracts: [], inserts: [] };

  const intents = Array.isArray(ctx.departureIntents) ? ctx.departureIntents : [];
  for (const intent of intents) {
    if (!ctx.budgets.take("ioExtracts", 1)) break;
    ctx.ioQueue.extracts.push({ intent });
    bumpCounter(ctx, "departures_intended");
  }
  ctx.departureIntents = [];

  let processed = 0;
  const maxDepartures = ctx.budgets.state.departures | 0;

  for (const orb of orbs) {
    if (processed >= maxDepartures) break;
    if (!orb || orb.state !== OrbStates.AT_PRISM) continue;
    if (orb.settlePending) continue;

    const prismKey = orb.currentPrismKey;
    const prismInfo = resolveBlockInfo ? resolveBlockInfo(prismKey) : null;
    const prismBlock = prismInfo?.block;
    notePrismXp(levelsManager, prismKey, prismBlock, orb.lastHandledPrismKey, orb);

    let nextKey = null;

    if (orb.mode === OrbModes.ATTUNED) {
      if (Array.isArray(orb.path) && orb.path.length > 1) {
        const idx = orb.pathIndex | 0;
        const nextIdx = idx + 1;
        if (orb.path[idx] === prismKey && orb.path[nextIdx]) {
          nextKey = orb.path[nextIdx];
          orb.pathIndex = nextIdx;
        } else {
          orb.pathIndex = 0;
          const path = ensurePathForOrb(ctx, orb);
          if (path) nextKey = path[1];
        }
      } else {
        const path = ensurePathForOrb(ctx, orb);
        if (path) nextKey = path[1];
      }
      if (!nextKey) {
        nextKey = selectDriftFallback(ctx, orb, prismKey);
      }
    } else if (orb.mode === OrbModes.DRIFT) {
      if (orb.driftSinkKey && orb.currentPrismKey !== orb.driftSinkKey) {
        const path = ensurePathForOrb(ctx, orb);
        if (path) nextKey = path[1];
      }
      if (!nextKey) {
        const drift = resolveDrift(ctx, {
          sourcePrismKey: prismKey,
          itemTypeId: orb.itemTypeId,
          count: orb.count,
        });
        if (drift) {
          orb.driftSinkKey = drift.destPrismKey;
          orb.path = drift.path;
          orb.pathIndex = 0;
          nextKey = drift.path?.[1] || null;
        } else {
          orb.mode = OrbModes.WALKING;
          bumpCounter(ctx, "drift_walkers");
        }
      }
    }

    if (orb.mode === OrbModes.WALKING) {
      nextKey = pickWalkingNeighbor(ctx, orb);
    }

    if (!nextKey) {
      continue;
    }

    if (prismBlock) {
      const tier = getPrismTier(prismBlock);
      const stepTicks = levelsManager?.getOrbStepTicks
        ? levelsManager.getOrbStepTicks(tier)
        : Math.max(1, Number(ctx.cfg.orbStepTicks) || 16);
      orb.speed = 1 / Math.max(1, stepTicks);
    }

    if (!assignEdge(orb, linkGraph, prismKey, nextKey)) {
      bumpCounter(ctx, "missing_edge");
      let rerouteKey = null;

      if (orb.mode === OrbModes.ATTUNED) {
        const path = ensurePathForOrb(ctx, orb);
        if (path) rerouteKey = path[1] || null;
        if (!rerouteKey) rerouteKey = selectDriftFallback(ctx, orb, prismKey);
      } else if (orb.mode === OrbModes.DRIFT) {
        const drift = resolveDrift(ctx, {
          sourcePrismKey: prismKey,
          itemTypeId: orb.itemTypeId,
          count: orb.count,
        });
        if (drift) {
          orb.driftSinkKey = drift.destPrismKey;
          orb.path = drift.path;
          orb.pathIndex = 0;
          rerouteKey = drift.path?.[1] || null;
        } else {
          orb.mode = OrbModes.WALKING;
          bumpCounter(ctx, "drift_walkers");
        }
      }

      if (orb.mode === OrbModes.WALKING) {
        rerouteKey = pickWalkingNeighbor(ctx, orb);
      }

      if (!rerouteKey || !assignEdge(orb, linkGraph, prismKey, rerouteKey)) {
        continue;
      }
    }

    bumpCounter(ctx, "departures");
    processed++;
  }
}






