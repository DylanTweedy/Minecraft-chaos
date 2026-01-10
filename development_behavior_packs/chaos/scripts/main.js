// scripts/main.js
// DEBUG: Reverting to working test, then testing imports one by one
// Issue: Import of bootstrap/index.js causes module to fail silently (likely broken import chain)

import { world, system } from "@minecraft/server";

// Working test - this confirmed scripts are functional
system.runTimeout(() => {
  try {
    if (world && typeof world.sendMessage === "function") {
      world.sendMessage("§a[Main] ✓ Scripts working - testing bootstrap import...");
      
      // Try to import bootstrap dynamically to catch import errors
      import("./chaos/bootstrap/index.js").then((module) => {
        try {
          world.sendMessage("§a[Main] ✓ Bootstrap module imported successfully");
          
          // Try calling startChaos
          if (module.startChaos) {
            module.startChaos({ world, system });
            world.sendMessage("§a[Main] ✓ startChaos called");
          } else {
            world.sendMessage("§c[Main] startChaos not found in module");
          }
        } catch (e) {
          world.sendMessage("§c[Main] Error calling startChaos: " + (e?.message || String(e)));
        }
      }).catch((importError) => {
        world.sendMessage("§c[Main] Bootstrap import FAILED: " + (importError?.message || String(importError)));
        world.sendMessage("§e[Main] This means a dependency has a broken import");
      });
    }
  } catch (e) {
    // Can't send error if world.sendMessage fails
  }
}, 10);
