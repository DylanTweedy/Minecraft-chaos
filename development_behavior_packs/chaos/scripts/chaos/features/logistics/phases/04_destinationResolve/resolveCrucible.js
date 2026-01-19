// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveCrucible.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";

export function resolveCrucible(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const endpointIndex = ctx.indexes?.endpointIndex;
  if (!linkGraph || !endpointIndex) return null;
  const candidates = endpointIndex.crucible || [];
  if (candidates.length === 0) return null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate, path };
  }

  return null;
}

