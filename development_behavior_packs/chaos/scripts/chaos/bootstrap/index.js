// scripts/chaos/bootstrap/index.js
import { bootChaos } from "./bootChaos.js";
import { startSystems } from "./startSystems.js";
import { startTransferLoop } from "./transferLoop.js";
import { registerWandComponent } from "./components.js";

import { setPending, getPending, clearPending } from "../core/state.js";
import { getPairsMap, loadPairsFromWorldSafe, savePairsToWorldSafe, isPersistenceEnabled } from "../features/links/pairs.js";
import { toggleOutput } from "../features/links/pairs.js";
import { fxSelectInput, fxPairSuccess, fxTransferItem } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeLinkFx, makeTransferFx } from "../fx/presets.js";
import { getGlobalInputCount, getGlobalLinkCount, getPerInputOutputCount } from "../core/stats.js";
import { makeKeyFromBlock, pendingToKey } from "../features/links/keys.js";
import { handleWandUseOn } from "../features/links/wand.js";

const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

export function startChaos(ctx) {
  const { world, system } = ctx;

  let pairsReady = false;

  startSystems();

  // Boot (DP load delayed inside bootstrap)
  bootChaos({
    world,
    system,
    loadPairsFromWorldSafe,
    isPersistenceEnabled,
    getPairsMap,
    getGlobalInputCount,
    getGlobalLinkCount,
    onReady: () => {
      pairsReady = true;
    },
  });

  const linkFx = makeLinkFx();
  const transferFx = makeTransferFx();

  startTransferLoop({
    world,
    system,
    isPairsReady: () => pairsReady,
    getPairsMap,
    fxTransferItem,
    FX: transferFx,
  });

  registerWandComponent({
    system,
    isPairsReady: () => pairsReady,
    WAND_ID,
    INPUT_ID,
    OUTPUT_ID,
    getPending,
    setPending,
    clearPending,
    toggleOutput,
    savePairsToWorldSafe,
    isPersistenceEnabled,
    getPairsMap,
    getGlobalInputCount,
    getGlobalLinkCount,
    getPerInputOutputCount,
    makeKeyFromBlock,
    pendingToKey,
    fxSelectInput,
    fxPairSuccess,
    handleWandUseOn,
    FX: linkFx,
  });
}
