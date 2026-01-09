// scripts/main.js
import { world, system } from "@minecraft/server";

// If this import fails, the module won't load at all (no error messages possible)
import { startChaos } from "./chaos/bootstrap/index.js";

// This message will only appear if the import above succeeded
system.runTimeout(() => {
  try {
    const players = world.getAllPlayers();
    for (const player of players) {
      try {
        player.sendMessage("§a[Chaos] Script loaded! (import succeeded)");
        if (typeof startChaos !== "function") {
          player.sendMessage("§c[Chaos] ERROR: startChaos is not a function!");
          return;
        }
        startChaos({ world, system });
        player.sendMessage("§7[Chaos] startChaos called");
      } catch (err) {
        try {
          player.sendMessage(`§c[Chaos] Error: ${err?.message || String(err)}`);
          if (err?.stack) {
            const stack = err.stack.substring(0, 300);
            player.sendMessage(`§c[Chaos] Stack: ${stack}`);
          }
        } catch {}
      }
    }
  } catch (err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        try {
          player.sendMessage(`§c[Chaos] Fatal: ${err?.message || String(err)}`);
        } catch {}
      }
    } catch {}
  }
}, 1);
