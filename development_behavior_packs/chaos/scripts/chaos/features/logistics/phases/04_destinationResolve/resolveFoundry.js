// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveFoundry.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { getFoundryState } from "../../systems/foundryState.js";

export function resolveFoundry(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const endpointIndex = ctx.indexes?.endpointIndex;
  if (!linkGraph || !endpointIndex) return null;
  const candidates = endpointIndex.foundry || [];
  if (candidates.length === 0) return null;

  let pathAttempted = false;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const state = getFoundryState(candidate);
    const maxFlux = Math.max(0, Number(ctx.cfg?.foundryMaxFluxStored) || 0);
    if (state && maxFlux > 0 && (state.flux | 0) >= maxFlux) continue;
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    pathAttempted = true;
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate, path };
  }

  if (pathAttempted) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_FOUNDRY_NO_PATH,
      "Foundry: none (no path to foundry)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_foundry_no_path");
  }

  return null;
}
