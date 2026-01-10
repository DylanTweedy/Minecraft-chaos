// scripts/chaos/bootstrap/index.js
import { bootChaos } from "./bootChaos.js";
import { startSystems } from "./startSystems.js";
// STEP 1: Enable script loader utilities (already used by startSystems, should be safe)
import { registerScript, markScriptLoaded, notifyPlayers } from "../core/scriptLoader.js";
// STEP 2: Enable component registrations
import { registerMagicMirrorComponent, registerDeathmarkComponent, registerInsightLensComponent, registerInsightGogglesComponent } from "./components.js";
import { handleMirrorUse, handleMirrorUseOn, handleMirrorEntityAttack } from "../features/magicMirror.js";
// STEP 3: Enable transfer loop
import { startTransferLoop } from "./transferLoop.js";
import { fxTransferItem } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeTransferFx } from "../fx/presets.js";

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

    // Minimal test message
    try {
      if (world && typeof world.sendMessage === "function") {
        world.sendMessage("§a[StartChaos] startChaos() called");
      }
    } catch {}

    // Comment out everything for testing
    /*
    // Register main systems
    registerScript("Main Bootstrap");
    registerScript("Transfer Loop");
    registerScript("Magic Mirror");
    registerScript("Deathmark");
    registerScript("Insight Lens");
    registerScript("Insight Goggles");

    startSystems();

  // Boot (simplified - no pairs loading needed)
  bootChaos({
    world,
    system,
  });
  markScriptLoaded("Main Bootstrap");

  const transferFx = makeTransferFx();

  // Start transfer loop
  startTransferLoop({
    world,
    system,
    fxTransferItem,
    FX: transferFx,
  });
  
  markScriptLoaded("Transfer Loop");

  registerMagicMirrorComponent({
    system,
    world,
    MIRROR_ID,
    handleMirrorUse,
    handleMirrorUseOn,
    handleMirrorEntityAttack,
  });
  markScriptLoaded("Magic Mirror");

  registerDeathmarkComponent(system);
  markScriptLoaded("Deathmark");

  registerInsightLensComponent({
    system,
    world,
  });
  markScriptLoaded("Insight Lens");

  registerInsightGogglesComponent({
    system,
  });
  markScriptLoaded("Insight Goggles");
  
  // Send consolidated startup message after everything is loaded
  system.runTimeout(() => {
    try {
      const status = notifyPlayers(); // This will send script loading status if needed
      // Send a single clean startup summary
      world.sendMessage("§a[Chaos] ✓ Systems loaded and ready");
    } catch {}
  }, 30);
  */
  
  // STEP 1: Use script loader utilities for better logging
  registerScript("Main Bootstrap");
  registerScript("Transfer Loop");
  registerScript("Magic Mirror");
  registerScript("Deathmark");
  registerScript("Insight Lens");
  registerScript("Insight Goggles");
  
  // Call basic functions
  try {
    startSystems();
    markScriptLoaded("Main Bootstrap");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] startSystems() completed");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] startSystems error: " + (err?.message || String(err)));
    }
  }
  
  try {
    bootChaos({ world, system });
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] bootChaos() completed");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] bootChaos error: " + (err?.message || String(err)));
    }
  }
  
  // STEP 3: Start transfer loop
  try {
    const transferFx = makeTransferFx();
    startTransferLoop({
      world,
      system,
      fxTransferItem,
      FX: transferFx,
    });
    markScriptLoaded("Transfer Loop");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] Transfer Loop started");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] Transfer Loop error: " + (err?.message || String(err)));
    }
  }
  
  // STEP 2: Register component systems
  try {
    registerMagicMirrorComponent({
      system,
      world,
      MIRROR_ID,
      handleMirrorUse,
      handleMirrorUseOn,
      handleMirrorEntityAttack,
    });
    markScriptLoaded("Magic Mirror");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] Magic Mirror registered");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] Magic Mirror error: " + (err?.message || String(err)));
    }
  }
  
  try {
    registerDeathmarkComponent(system);
    markScriptLoaded("Deathmark");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] Deathmark registered");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] Deathmark error: " + (err?.message || String(err)));
    }
  }
  
  try {
    registerInsightLensComponent({
      system,
      world,
    });
    markScriptLoaded("Insight Lens");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] Insight Lens registered");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] Insight Lens error: " + (err?.message || String(err)));
    }
  }
  
  try {
    registerInsightGogglesComponent({
      system,
    });
    markScriptLoaded("Insight Goggles");
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[StartChaos] Insight Goggles registered");
    }
  } catch (err) {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§c[StartChaos] Insight Goggles error: " + (err?.message || String(err)));
    }
  }
  
  // STEP 4: Send consolidated startup message after everything is loaded
  system.runTimeout(() => {
    try {
      if (notifyPlayers && typeof notifyPlayers === "function") {
        notifyPlayers(); // This will send script loading status if needed
      }
      if (world && typeof world.sendMessage === "function") {
        world.sendMessage("§a[Chaos] ✓ Systems loaded and ready");
      }
    } catch (err) {
      // Ignore errors in notification
    }
  }, 30);
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
