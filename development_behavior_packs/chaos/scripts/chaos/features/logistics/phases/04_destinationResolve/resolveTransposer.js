// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveTransposer.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { getLinkedKey } from "../../../transposer/pairs.js";
import { getChargeLimits, getSharedStateKey, getSharedStateSnapshot } from "../../../transposer/state.js";

export function resolveTransposer(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const endpointIndex = ctx.indexes?.endpointIndex;
  if (!linkGraph || !endpointIndex) return null;
  const candidates = endpointIndex.transposer || [];
  if (candidates.length === 0) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_NONE,
      "Transposer: none (no transposers found)",
      { itemTypeId: intent.itemTypeId }
    );
    return null;
  }

  let pathAttempted = false;
  const { overchargeMax } = getChargeLimits();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const linkedKey = getLinkedKey(candidate);
    const stateKey = getSharedStateKey(candidate, linkedKey);
    if (stateKey) {
      const snapshot = getSharedStateSnapshot(stateKey);
      const charge = Math.max(0, snapshot?.charge | 0);
      if (charge >= Math.max(0, overchargeMax | 0)) continue;
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
      "Transposer: none (no path)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_transposer_no_path");
  }

  return null;
}
