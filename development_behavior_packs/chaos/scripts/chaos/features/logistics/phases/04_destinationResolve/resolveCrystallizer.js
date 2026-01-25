// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveCrystallizer.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";

export function resolveCrystallizer(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const endpointIndex = ctx.indexes?.endpointIndex;
  if (!linkGraph || !endpointIndex) return null;
  const candidates = endpointIndex.crystallizer || [];
  if (candidates.length === 0) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_NONE,
      "Crystallizer: none (no crystallizers found)",
      { itemTypeId: intent.itemTypeId }
    );
    return null;
  }

  let pathAttempted = false;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    pathAttempted = true;
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate, path };
  }

  if (pathAttempted) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_DRIFT_NO_PATH,
      "Crystallizer: none (no path)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_crystallizer_no_path");
  }

  return null;
}
