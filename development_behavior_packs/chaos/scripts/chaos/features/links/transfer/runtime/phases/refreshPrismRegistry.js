// scripts/chaos/features/links/transfer/runtime/phases/refreshPrismRegistry.js
import { ok, phaseStep } from "../helpers/result.js";

export function createRefreshPrismRegistryPhase(deps) {
  const services = deps?.services || {};
  const resolvePrismKeysFromDeps = deps?.resolvePrismKeys;

  function getResolvePrismKeys(ctx) {
    return (ctx?.services && ctx.services.resolvePrismKeys) || services.resolvePrismKeys || resolvePrismKeysFromDeps;
  }

  return {
    name: "refreshPrismRegistry",
    run(ctx) {
      const resolvePrismKeys = getResolvePrismKeys(ctx);
      if (typeof resolvePrismKeys !== "function") return ok();

      const prismKeys = resolvePrismKeys();
      ctx.prismKeys = Array.isArray(prismKeys) ? prismKeys : [];

      phaseStep(ctx, `refreshPrismRegistry: ${ctx.prismKeys.length} prisms`);

      return ok();
    },
  };
}

