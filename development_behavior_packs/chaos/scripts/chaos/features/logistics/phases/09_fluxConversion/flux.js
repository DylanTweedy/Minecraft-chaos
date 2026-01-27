// scripts/chaos/features/logistics/phases/09_fluxConversion/flux.js
import { getFluxTier, getFluxTypeForTier, isFluxTypeId } from "../../../flux.js";
import { fxFluxGenerate, fxFluxRefine } from "../../../../fx/fx.js";
import { OrbModes } from "../../state/enums.js";
import { bumpCounter } from "../../util/insightCounters.js";

export function applyFluxConversion(ctx) {
  const cfg = ctx.cfg || {};
  const orbs = ctx.state?.orbs || [];
  const minHops = Math.max(1, Number(cfg.fluxMinHops) || 6);
  const minSpeed = Math.max(0.1, Number(cfg.fluxMinSpeed) || 0.5);
  const refineSpeed = Math.max(0.1, Number(cfg.fluxRefineSpeed) || 0.8);
  const refineHopInterval = Math.max(1, Number(cfg.fluxRefineHopInterval) || 6);

  let processed = 0;
  const max = ctx.budgets.state.flux | 0;

  function resolvePrismBlockForOrb(orb) {
    const prismKey = orb?.currentPrismKey || orb?.edgeFromKey || orb?.edgeToKey || orb?.destPrismKey || orb?.sourcePrismKey;
    if (!prismKey) return null;
    const info = ctx.services?.resolveBlockInfo?.(prismKey);
    return info?.block || null;
  }

  for (const orb of orbs) {
    if (processed >= max) break;
    if (!orb) continue;

    const speed = Number.isFinite(orb.edgeSpeed) ? orb.edgeSpeed : (orb.speed || 0);
    if ((orb.mode === OrbModes.DRIFT || orb.mode === OrbModes.WALKING) && !isFluxTypeId(orb.itemTypeId)) {
      if (orb.hops >= minHops && speed >= minSpeed) {
        orb.itemTypeId = getFluxTypeForTier(1);
        orb.mode = OrbModes.FLUX;
        bumpCounter(ctx, "flux_converted");
        const prismBlock = resolvePrismBlockForOrb(orb);
        if (prismBlock) fxFluxGenerate(prismBlock, ctx?.FX);
      }
    } else if (isFluxTypeId(orb.itemTypeId)) {
      const tier = getFluxTier(orb.itemTypeId);
      if (tier > 0 && tier < 5 && orb.hops > 0 && (orb.hops % refineHopInterval) === 0 && speed >= refineSpeed) {
        orb.itemTypeId = getFluxTypeForTier(tier + 1);
        bumpCounter(ctx, "flux_refined");
        const prismBlock = resolvePrismBlockForOrb(orb);
        if (prismBlock) fxFluxRefine(prismBlock, ctx?.FX, orb.itemTypeId);
      }
    }

    processed++;
  }
}






