// scripts/chaos/features/logistics/phases/04_destinationResolve/resolver.js
import { bumpCounter } from "../../util/insightCounters.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { emitTrace } from "../../../../core/insight/trace.js";
import { resolveAttuned } from "./resolveAttuned.js";
import { resolveCrystallizer } from "./resolveCrystallizer.js";
import { resolveCrucible } from "./resolveCrucible.js";
import { resolveDrift } from "./resolveDrift.js";
import { ResolveKinds, makeResolveResult } from "./resolveResult.js";
import { isFluxTypeId } from "../../../flux.js";

function buildDeparture(intent, resolved, tick) {
  const path = Array.isArray(resolved?.path) ? resolved.path.slice() : null;
  const mode = isFluxTypeId(intent.itemTypeId)
    ? "flux"
    : (resolved.kind === ResolveKinds.DRIFT ? "drift" : "attuned");
  return {
    id: `depart_${intent.id}`,
    exportId: intent.id,
    sourcePrismKey: intent.sourcePrismKey,
    containerKey: intent.containerKey,
    destContainerKey: resolved?.destContainerKey || null,
    slot: intent.slot,
    itemTypeId: intent.itemTypeId,
    count: intent.count,
    mode,
    resolveKind: resolved.kind,
    destPrismKey: resolved?.destPrismKey || null,
    driftSinkKey: resolved.kind === ResolveKinds.DRIFT ? resolved?.destPrismKey || null : null,
    path,
    createdAtTick: tick,
  };
}

export function resolveDepartureIntents(ctx) {
  const intents = Array.isArray(ctx.exportIntents) ? ctx.exportIntents : [];
  const departures = [];
  const budget = ctx.budgets;
  const nowTick = ctx.nowTick | 0;
  const noneNoted = new Set();

  for (const intent of intents) {
    bumpCounter(ctx, "resolve_intents");
    if (!budget?.take("resolves", 1)) {
      bumpCounter(ctx, "throttles");
      break;
    }
    let resolved = null;
    if (isFluxTypeId(intent.itemTypeId)) {
      resolved = resolveCrystallizer(ctx, intent);
      if (resolved) {
        const result = makeResolveResult(ResolveKinds.CRYSTALLIZER, resolved);
        departures.push(buildDeparture(intent, result, nowTick));
        bumpCounter(ctx, "resolved_crystallizer");
        if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
          emitTrace(null, "transfer", {
            text: `[Transfer] Resolve crystallizer ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${result.destPrismKey}`,
            category: "transfer",
            dedupeKey: `transfer_resolve_crystal_${intent.sourcePrismKey}_${intent.itemTypeId}`,
          });
        }
        continue;
      }
    }

    resolved = resolveAttuned(ctx, intent);
    if (resolved) {
      const result = makeResolveResult(ResolveKinds.ATTUNED, resolved);
      departures.push(buildDeparture(intent, result, nowTick));
      bumpCounter(ctx, "resolved_attuned");
      if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
        emitTrace(null, "transfer", {
          text: `[Transfer] Resolve attuned ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${result.destPrismKey} destC=${result.destContainerKey || "unknown"}`,
          category: "transfer",
          dedupeKey: `transfer_resolve_attuned_${intent.sourcePrismKey}_${intent.itemTypeId}`,
        });
      }
      continue;
    }

    resolved = resolveCrucible(ctx, intent);
    if (resolved) {
      const result = makeResolveResult(ResolveKinds.CRUCIBLE, resolved);
      departures.push(buildDeparture(intent, result, nowTick));
      bumpCounter(ctx, "resolved_crucible");
      if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
        emitTrace(null, "transfer", {
          text: `[Transfer] Resolve crucible ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${result.destPrismKey} destC=${result.destContainerKey || "unknown"}`,
          category: "transfer",
          dedupeKey: `transfer_resolve_crucible_${intent.sourcePrismKey}_${intent.itemTypeId}`,
        });
      }
      continue;
    }

    resolved = resolveDrift(ctx, intent);
    if (resolved) {
      const result = makeResolveResult(ResolveKinds.DRIFT, resolved);
      departures.push(buildDeparture(intent, result, nowTick));
      bumpCounter(ctx, "resolved_drift");
      if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
        emitTrace(null, "transfer", {
          text: `[Transfer] Resolve drift ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${result.destPrismKey} destC=${result.destContainerKey || "unknown"}`,
          category: "transfer",
          dedupeKey: `transfer_resolve_drift_${intent.sourcePrismKey}_${intent.itemTypeId}`,
        });
      }
      continue;
    }

    bumpCounter(ctx, "resolved_none");
    if (!noneNoted.has(intent.sourcePrismKey)) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.RESOLVE_NONE,
        "Resolve: none (no viable destinations)",
        { itemTypeId: intent.itemTypeId }
      );
      noneNoted.add(intent.sourcePrismKey);
    }
  }

  ctx.departureIntents = departures;
  return departures;
}
