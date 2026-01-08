// scripts/chaos/bootstrap/startSystems.js
import { world } from "@minecraft/server";
import { startLinkVision } from "../systems/linkVision.js";
import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";
import { startCrystallizerSystem } from "../crystallizer.js";
import { startPrestigeSystem } from "../prestige.js";

export function startSystems() {
  // Start FX queue first so spawns don't stall if later systems throw.
  try {
    world.sendMessage("§7[Chaos] Starting FX Queue...");
    startFxQueue();
    world.sendMessage("§7[Chaos] ✓ FX Queue started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ FX Queue failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Link Vision...");
    startLinkVision();
    world.sendMessage("§7[Chaos] ✓ Link Vision started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Link Vision failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Cleanup On Break...");
    startCleanupOnBreak();
    world.sendMessage("§7[Chaos] ✓ Cleanup On Break started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Cleanup On Break failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Filter Interact...");
    startFilterInteract();
    world.sendMessage("§7[Chaos] ✓ Filter Interact started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Filter Interact failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Beam Sim...");
    startBeamSimV0();
    world.sendMessage("§7[Chaos] ✓ Beam Sim started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Beam Sim failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Crystallizer System...");
    startCrystallizerSystem();
    world.sendMessage("§7[Chaos] ✓ Crystallizer System started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Crystallizer System failed: ${err?.message || String(err)}`);
  }
  
  try {
    world.sendMessage("§7[Chaos] Starting Prestige System...");
    startPrestigeSystem();
    world.sendMessage("§7[Chaos] ✓ Prestige System started");
  } catch (err) {
    world.sendMessage(`§c[Chaos] ✗ Prestige System failed: ${err?.message || String(err)}`);
  }
  
  // Debug: Show which modules loaded
  try {
    world.sendMessage("§a[Chaos] All systems initialization complete");
  } catch {}
}
