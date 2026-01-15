// scripts/chaos/features/links/transfer/runtime/phases/validateLinks.js
import { ok, phaseStep } from "../helpers/result.js";

export function createValidateLinksPhase(deps) {
  const cfg = deps?.cfg || {};
  const services = deps?.services || {};

  return {
    name: "validateLinks",
    run(ctx) {
      const registry = (ctx?.services && ctx.services.prismRegistry) || services.prismRegistry;
      const linkGraph = (ctx?.services && ctx.services.linkGraph) || services.linkGraph;
      const nowTick = ctx?.nowTick || 0;

      if (registry && typeof registry.validateBudgeted === "function") {
        const budget = Math.max(1, Number(cfg.prismValidationBudgetPerTick || 32) | 0);
      registry.validateBudgeted(budget, nowTick);
      }

      if (linkGraph && typeof linkGraph.rebuildDirtyBudgeted === "function") {
        const rebuildBudget = Math.max(1, Number(cfg.linkRebuildBudgetPerTick || 8) | 0);
        linkGraph.rebuildDirtyBudgeted(rebuildBudget, nowTick);
      }

      if (linkGraph && typeof linkGraph.validateEdgesBudgeted === "function") {
        const validateBudget = Math.max(1, Number(cfg.linkValidateBudgetPerTick || 16) | 0);
        linkGraph.validateEdgesBudgeted(validateBudget, nowTick);
      }

      phaseStep(ctx, "validateLinks");
      return ok();
    },
  };
}
