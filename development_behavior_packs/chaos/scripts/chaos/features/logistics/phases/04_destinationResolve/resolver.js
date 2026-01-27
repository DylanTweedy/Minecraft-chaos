// scripts/chaos/features/logistics/phases/04_destinationResolve/resolver.js
import { bumpCounter } from "../../util/insightCounters.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { emitTrace } from "../../../../core/insight/trace.js";
import { resolveAttuned } from "./resolveAttuned.js";
import { resolveCollector } from "./resolveCollector.js";
import { resolveCrystallizer } from "./resolveCrystallizer.js";
import { resolveCrucible } from "./resolveCrucible.js";
import { resolveDrift } from "./resolveDrift.js";
import { resolveFoundry } from "./resolveFoundry.js";
import { resolveTransposer } from "./resolveTransposer.js";
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
    { kind: ResolveKinds.FOUNDRY, fn: resolveFoundry, counter: "resolved_foundry", trace: "foundry" },
    { kind: ResolveKinds.CRYSTALLIZER, fn: resolveCrystallizer, counter: "resolved_crystallizer", trace: "crystal" },
    { kind: ResolveKinds.COLLECTOR, fn: resolveCollector, counter: "resolved_collector", trace: "collector" },
    { kind: ResolveKinds.TRANSPOSER, fn: resolveTransposer, counter: "resolved_transposer", trace: "transposer" },
  ]);

  for (const opt of options) {
    const resolved = opt.fn(ctx, intent);
    if (!resolved) continue;
    const result = makeResolveResult(opt.kind, resolved);
    return { result, counter: opt.counter, trace: opt.trace };
  }

  return null;
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
    let resolved = resolveAttuned(ctx, intent);
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

    if (isFluxTypeId(intent.itemTypeId)) {
      const fluxResolved = resolveFluxEndpoint(ctx, intent);
      if (fluxResolved?.result) {
        departures.push(buildDeparture(intent, fluxResolved.result, nowTick));
        bumpCounter(ctx, fluxResolved.counter);
        if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function") {
          emitTrace(null, "transfer", {
            text: `[Transfer] Resolve ${fluxResolved.trace} ${intent.sourcePrismKey} item=${intent.itemTypeId} src=${intent.containerKey} dest=${fluxResolved.result.destPrismKey}`,
            category: "transfer",
            dedupeKey: `transfer_resolve_${fluxResolved.trace}_${intent.sourcePrismKey}_${intent.itemTypeId}`,
          });
        }
        continue;
      }
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
