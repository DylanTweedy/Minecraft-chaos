// scripts/main.js
import { world, system } from "@minecraft/server";
import { startChaos } from "./chaos/bootstrap/index.js";

try {
  system.runTimeout(() => {
    try {
      world.sendMessage("§a[Chaos] Script loaded!");
      startChaos({ world, system });
    } catch (err) {
      try {
        world.sendMessage(`§c[Chaos] Error: ${err?.message || String(err)}`);
        world.sendMessage(`§c[Chaos] Stack: ${err?.stack || "no stack"}`);
      } catch {}
    }
  }, 1);
} catch (err) {
  // If we can't even set up the timeout, log it
  try {
    world.sendMessage(`§c[Chaos] FATAL: Cannot initialize: ${err?.message || String(err)}`);
  } catch {}
}
