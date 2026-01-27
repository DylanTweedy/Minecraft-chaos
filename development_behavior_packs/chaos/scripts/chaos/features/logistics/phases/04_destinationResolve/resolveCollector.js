// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveCollector.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { getCollectorState } from "../../collectorState.js";

export function resolveCollector(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const endpointIndex = ctx.indexes?.endpointIndex;
  if (!linkGraph || !endpointIndex) return null;
  const candidates = endpointIndex.collector || [];
  if (candidates.length === 0) return null;

  let pathAttempted = false;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const st = getCollectorState(candidate);
    if (st && Number.isFinite(st.charge) && Number.isFinite(st.maxCharge)) {
      if ((st.charge | 0) >= (st.maxCharge | 0)) continue;
    }
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
      "Collector: none (no path)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_collector_no_path");
  }

  return null;
}
