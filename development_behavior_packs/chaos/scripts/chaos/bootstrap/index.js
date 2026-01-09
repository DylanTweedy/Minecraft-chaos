// scripts/chaos/bootstrap/index.js
import { bootChaos } from "./bootChaos.js";
import { startSystems } from "./startSystems.js";
// TESTING: Uncommented to test pathfinder import
import { startTransferLoop } from "./transferLoop.js";
import { registerWandComponent, registerMagicMirrorComponent, registerDeathmarkComponent } from "./components.js";

import { setPending, getPending, clearPending } from "../core/state.js";
import { getPairsMap, loadPairsFromWorldSafe, savePairsToWorldSafe, isPersistenceEnabled } from "../features/links/pairs.js";
import { toggleOutput } from "../features/links/pairs.js";
import { fxSelectInput, fxPairSuccess, fxTransferItem } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeLinkFx, makeTransferFx } from "../fx/presets.js";
import { getGlobalInputCount, getGlobalLinkCount, getPerInputOutputCount } from "../core/stats.js";
import { makeKeyFromBlock, pendingToKey } from "../features/links/shared/keys.js";
import { handleWandUseOn } from "../features/links/wand.js";
import { handleMirrorUse, handleMirrorUseOn, handleMirrorEntityAttack } from "../features/magicMirror.js";

const WAND_ID = "chaos:wand";
const PRISM_ID = "chaos:prism";
const MIRROR_ID = "chaos:magic_mirror";

export function startChaos(ctx) {
  try {
    const { world, system } = ctx;

    if (!world) {
      throw new Error("world is undefined in startChaos context");
    }
    if (!system) {
      throw new Error("system is undefined in startChaos context");
    }

    try {
      world.sendMessage("§7[Chaos] startChaos: Starting systems...");
    } catch {}

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

  // TESTING: Uncommented to test pathfinder import
  startTransferLoop({
    world,
    system,
    isPairsReady: () => pairsReady,
    getPairsMap,
    fxTransferItem,
    FX: transferFx,
  });
  
  try {
    world.sendMessage("§7[Chaos] Transfer loop enabled for testing");
  } catch {}

  registerWandComponent({
    system,
    isPairsReady: () => pairsReady,
    WAND_ID,
    PRISM_ID, // Unified prism system
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

  registerMagicMirrorComponent({
    system,
    world,
    MIRROR_ID,
    handleMirrorUse,
    handleMirrorUseOn,
    handleMirrorEntityAttack,
  });

  registerDeathmarkComponent(system);
    
    try {
      world.sendMessage("§7[Chaos] startChaos: All components registered");
      world.sendMessage("§a[Chaos] Magic Mirror script loaded! Right-click to teleport, crouch+right-click to go up, punch entity to send to spawn.");
    } catch {}
  } catch (err) {
    try {
      if (ctx?.world) {
        ctx.world.sendMessage(`§c[Chaos] Error in startChaos: ${err?.message || String(err)}`);
        ctx.world.sendMessage(`§c[Chaos] Stack: ${err?.stack || "no stack"}`);
      }
    } catch {}
    throw err;
  }
}
