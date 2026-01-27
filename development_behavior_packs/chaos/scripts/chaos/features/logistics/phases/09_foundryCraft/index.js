// scripts/chaos/features/logistics/phases/09_foundryCraft/index.js
import { ok } from "../../util/result.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";
import { getFoundryFilterList } from "../../systems/foundryFilters.js";
import { getFoundryState, spendFoundryFlux, bumpFoundryCursor } from "../../systems/foundryState.js";
import { getCrucibleValue } from "../../systems/crucibleValues.js";
import { dropItemAt } from "../../util/positions.js";

export function createFoundryCraftPhase() {
  return {
    name: "09_foundryCraft",
    run(ctx) {
      const endpointIndex = ctx.indexes?.endpointIndex;
      if (!endpointIndex || !Array.isArray(endpointIndex.foundry)) return ok();
      const foundries = endpointIndex.foundry;
      if (foundries.length === 0) return ok();

      const maxPerTick = Math.max(0, Number(ctx.cfg?.foundryCraftsPerTick) || 0);
      if (maxPerTick <= 0) return ok();

      if (!ctx.state.foundryCursor) ctx.state.foundryCursor = 0;
      let cursor = ctx.state.foundryCursor | 0;
      let crafted = 0;

      for (let i = 0; i < foundries.length && crafted < maxPerTick; i++) {
        const idx = Math.abs(cursor + i) % foundries.length;
        const prismKey = foundries[idx];
        if (!prismKey) continue;
        const info = ctx.services?.resolveBlockInfo?.(prismKey);
        const block = info?.block;
        const dim = info?.dim;
        if (!block || !dim || block.typeId !== "chaos:foundry") continue;

        const list = getFoundryFilterList(block);
        if (!Array.isArray(list) || list.length === 0) continue;

        const state = getFoundryState(prismKey);
        if (!state) continue;

        const itemIdx = Math.abs(state.cursor | 0) % list.length;
        const targetId = list[itemIdx];
        if (!targetId) {
          bumpFoundryCursor(prismKey, list.length);
          continue;
        }

        const cost = Math.max(0, getCrucibleValue(targetId) | 0);
        if (cost <= 0) {
          bumpFoundryCursor(prismKey, list.length);
          continue;
        }

        if ((state.flux | 0) < cost) {
          bumpFoundryCursor(prismKey, list.length);
          continue;
        }

        if (spendFoundryFlux(prismKey, cost)) {
          dropItemAt(dim, block.location, targetId, 1);
          bumpFoundryCursor(prismKey, list.length);
          crafted++;
          if (ctx.services?.emitTrace) {
            ctx.services.emitTrace(null, "foundry", {
              text: `[Foundry] Craft ${targetId} cost=${cost}`,
              category: "foundry",
              dedupeKey: `foundry_craft_${prismKey}_${targetId}_${ctx.nowTick | 0}`,
              contextKey: prismKey,
            });
          }
        }
      }

      ctx.state.foundryCursor = (cursor + crafted) % Math.max(1, foundries.length);
      const interval = Math.max(1, Number(ctx.cfg?.insightReportIntervalTicks) || 20);
      if ((ctx.nowTick | 0) % interval === 0 && ctx.services?.emitTrace) {
        for (const prismKey of foundries) {
          const info = ctx.services?.resolveBlockInfo?.(prismKey);
          const block = info?.block;
          if (!block || block.typeId !== "chaos:foundry") continue;
          const list = getFoundryFilterList(block);
          const state = getFoundryState(prismKey);
          const nextItem = list.length > 0 ? list[(state.cursor | 0) % list.length] : "none";
          ctx.services.emitTrace(null, "foundry", {
            text: `[Foundry] flux=${state?.flux | 0} filters=${list.length} next=${nextItem}`,
            category: "foundry",
            contextKey: prismKey,
            dedupeKey: `foundry_status_${prismKey}_${ctx.nowTick | 0}`,
          });
        }
      }
      emitPhaseInsight(ctx, "09_foundryCraft", `crafted=${crafted} foundries=${foundries.length}`);
      return ok();
    },
  };
}
