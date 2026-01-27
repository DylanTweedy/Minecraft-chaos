// scripts/chaos/features/logistics/phases/08_lensAura/index.js
import { ok } from "../../util/result.js";
import { isBeamId } from "../../config.js";
import { parseKey } from "../../keys.js";
import { getLensEffect } from "../../systems/lensEffects.js";
import { emitPhaseInsight } from "../../util/phaseInsight.js";

export function createLensAuraPhase() {
  return {
    name: "08_lensAura",
    run(ctx) {
      const linkGraph = ctx.services?.linkGraph;
      const cacheManager = ctx.services?.cacheManager;
      if (!linkGraph || !cacheManager) return ok();

      const budget = Math.max(0, Number(ctx.cfg?.lensAuraSegmentsPerTick) || 0);
      if (budget <= 0) return ok();

      if (!ctx.state.lensAuraCursor) ctx.state.lensAuraCursor = 0;
      const cursor = ctx.state.lensAuraCursor | 0;
      const sample = linkGraph.getSegmentKeysSample
        ? linkGraph.getSegmentKeysSample(budget, cursor)
        : { keys: [], cursor };

      const keys = Array.isArray(sample?.keys) ? sample.keys : [];
      ctx.state.lensAuraCursor = sample?.cursor | 0;

      let applied = 0;
      for (const segKey of keys) {
        const parsed = parseKey(segKey);
        if (!parsed) continue;
        const dim = cacheManager.getDimensionCached(parsed.dimId);
        if (!dim) continue;
        const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
        if (!block || !isBeamId(block.typeId)) continue;

        const meta = linkGraph.getEdgeMetaForSegmentKey
          ? linkGraph.getEdgeMetaForSegmentKey(segKey)
          : null;
        const color = meta?.lensColor;
        if (!color) continue;
        const effectId = getLensEffect(color);
        if (!effectId) continue;

        const ampPerLens = Math.max(0, Number(ctx.cfg?.lensAuraAmplifierPerLens) || 0);
        const maxAmp = Math.max(0, Number(ctx.cfg?.lensAuraMaxAmplifier) || 0);
        const lensCount = Math.max(0, meta?.lensCount | 0);
        const amplifier = Math.min(maxAmp, Math.floor(lensCount * ampPerLens));
        const duration = Math.max(20, Number(ctx.cfg?.lensAuraDurationTicks) || 60);
        const radius = Math.max(0.25, Number(ctx.cfg?.lensAuraRadius) || 0.6);

        let entities = [];
        try {
          entities = dim.getEntities({
            location: { x: parsed.x + 0.5, y: parsed.y + 0.5, z: parsed.z + 0.5 },
            maxDistance: radius,
          }) || [];
        } catch {
          entities = [];
        }

        for (const ent of entities) {
          if (!ent || typeof ent.addEffect !== "function") continue;
          try {
            ent.addEffect(effectId, duration, {
              amplifier,
              showParticles: false,
            });
            applied++;
          } catch {
            // ignore
          }
        }
      }

      emitPhaseInsight(ctx, "08_lensAura", `applied=${applied} segments=${keys.length}`);
      if (applied > 0 && ctx.services?.emitTrace) {
        ctx.services.emitTrace(null, "lens", {
          text: `[Lens] Aura applied=${applied} segments=${keys.length}`,
          category: "lens",
          dedupeKey: `lens_aura_${ctx.nowTick | 0}`,
        });
      }
      return ok();
    },
  };
}
