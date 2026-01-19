// scripts/chaos/features/logistics/phases/09_fluxConversion/index.js
import { ok } from "../../util/result.js";
import { applyFluxConversion } from "./flux.js";

export function createFluxConversionPhase() {
  return {
    name: "09_fluxConversion",
    run(ctx) {
      applyFluxConversion(ctx);
      return ok();
    },
  };
}

