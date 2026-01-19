// scripts/chaos/features/logistics/phases/04_destinationResolve/index.js
import { ok } from "../../util/result.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { resolveAttuned } from "./resolveAttuned.js";
import { resolveCrucible } from "./resolveCrucible.js";
import { resolveDrift } from "./resolveDrift.js";

export function createDestinationResolvePhase() {
  return {
    name: "04_destinationResolve",
    run(ctx) {
      const intents = Array.isArray(ctx.exportIntents) ? ctx.exportIntents : [];
      const departures = [];

      for (const intent of intents) {
        if (!ctx.budgets.take("resolves", 1)) {
          bumpCounter(ctx, "throttles");
          break;
        }
        let resolved = resolveAttuned(ctx, intent);
        if (resolved) {
          departures.push({
            id: `depart_${intent.id}`,
            exportId: intent.id,
            sourcePrismKey: intent.sourcePrismKey,
            containerKey: intent.containerKey,
            slot: intent.slot,
            itemTypeId: intent.itemTypeId,
            count: intent.count,
            mode: "attuned",
            destPrismKey: resolved.destPrismKey,
            path: resolved.path,
            createdAtTick: ctx.nowTick | 0,
          });
          bumpCounter(ctx, "resolved_attuned");
          continue;
        }

        resolved = resolveCrucible(ctx, intent);
        if (resolved) {
          departures.push({
            id: `depart_${intent.id}`,
            exportId: intent.id,
            sourcePrismKey: intent.sourcePrismKey,
            containerKey: intent.containerKey,
            slot: intent.slot,
            itemTypeId: intent.itemTypeId,
            count: intent.count,
            mode: "crucible",
            destPrismKey: resolved.destPrismKey,
            path: resolved.path,
            createdAtTick: ctx.nowTick | 0,
          });
          bumpCounter(ctx, "resolved_crucible");
          continue;
        }

        resolved = resolveDrift(ctx, intent);
        if (resolved) {
          departures.push({
            id: `depart_${intent.id}`,
            exportId: intent.id,
            sourcePrismKey: intent.sourcePrismKey,
            containerKey: intent.containerKey,
            slot: intent.slot,
            itemTypeId: intent.itemTypeId,
            count: intent.count,
            mode: "drift",
            destPrismKey: resolved.destPrismKey,
            driftSinkKey: resolved.destPrismKey,
            path: resolved.path,
            createdAtTick: ctx.nowTick | 0,
          });
          bumpCounter(ctx, "resolved_drift");
          continue;
        }

        bumpCounter(ctx, "resolved_none");
      }

      ctx.departureIntents = departures;
      return ok();
    },
  };
}






