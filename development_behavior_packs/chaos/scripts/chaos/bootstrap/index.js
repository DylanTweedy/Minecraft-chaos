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
import { makeKeyFromBlock, pendingToKey } from "../features/links/shared/keys.js";
import { handleWandUseOn } from "../features/links/wand.js";
// TEMP: Comment out to test if this import is breaking things
// import { isPrismBlock } from "../features/links/transfer/config.js";

const WAND_ID = "chaos:wand";

// TEMP: Define locally to test
function isPrismBlock(block) {
  if (!block) return false;
  const typeId = block.typeId;
  return typeId === "chaos:prism_1" || typeId === "chaos:prism_2" || typeId === "chaos:prism_3" || typeId === "chaos:prism_4" || typeId === "chaos:prism_5";
}

export function startChaos(ctx) {
  try {
    const { world, system } = ctx;
    world.sendMessage("§7[Chaos] startChaos() called");

    let pairsReady = false;

    try {
      world.sendMessage("§7[Chaos] Starting systems...");
      startSystems();
      world.sendMessage("§7[Chaos] startSystems() completed");
    } catch (err) {
      world.sendMessage(`§c[Chaos] ERROR in startSystems(): ${err?.message || String(err)}`);
      throw err;
    }

    // Boot (DP load delayed inside bootstrap)
    try {
      world.sendMessage("§7[Chaos] Calling bootChaos()...");
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
          world.sendMessage("§7[Chaos] Pairs ready!");
        },
      });
      world.sendMessage("§7[Chaos] bootChaos() completed");
    } catch (err) {
      world.sendMessage(`§c[Chaos] ERROR in bootChaos(): ${err?.message || String(err)}`);
      throw err;
    }

    let linkFx, transferFx;
    try {
      world.sendMessage("§7[Chaos] Creating FX presets...");
      linkFx = makeLinkFx();
      transferFx = makeTransferFx();
      world.sendMessage("§7[Chaos] FX presets created");

      try {
        world.sendMessage("§7[Chaos] Starting transfer loop...");
        startTransferLoop({
          world,
          system,
          isPairsReady: () => pairsReady,
          getPairsMap,
          fxTransferItem,
          FX: transferFx,
        });
        world.sendMessage("§7[Chaos] Transfer loop started");
      } catch (err) {
        world.sendMessage(`§c[Chaos] ERROR in startTransferLoop(): ${err?.message || String(err)}`);
        throw err;
      }

      try {
        world.sendMessage("§7[Chaos] Registering wand component...");
        registerWandComponent({
          system,
          isPairsReady: () => pairsReady,
          WAND_ID,
          isPrismBlock,
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
        world.sendMessage("§7[Chaos] Wand component registered");
      } catch (err) {
        world.sendMessage(`§c[Chaos] ERROR in registerWandComponent(): ${err?.message || String(err)}`);
        throw err;
      }

      world.sendMessage("§a[Chaos] Bootstrap complete!");
    } catch (err) {
      world.sendMessage(`§c[Chaos] ERROR in FX/transfer/wand setup: ${err?.message || String(err)}`);
      throw err;
    }
  } catch (err) {
    try {
      const { world } = ctx;
      world.sendMessage(`§c[Chaos] FATAL ERROR in startChaos(): ${err?.message || String(err)}`);
    } catch {}
  }
}
