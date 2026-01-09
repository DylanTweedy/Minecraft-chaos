// scripts/chaos/bootstrap/startSystems.js
import { world, system } from "@minecraft/server";
import { startLinkVision } from "../systems/linkVision.js";
import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";
import { startCrystallizerSystem } from "../crystallizer.js";
import { startPrestigeSystem } from "../prestige.js";
import { startDeathmarkSystem } from "../deathmark.js";

export function startSystems() {
  // Start FX queue first so spawns don't stall if later systems throw.
  try { startFxQueue(); } catch {}
  try { startLinkVision(); } catch {}
  try { startCleanupOnBreak(); } catch {}
  try { startFilterInteract(); } catch {}
  try { startBeamSimV0(); } catch {}
  try { startCrystallizerSystem(); } catch {}
  try { startPrestigeSystem(); } catch {}
  try { startDeathmarkSystem(world, system); } catch {}
  
  // Debug: Show which modules loaded
  try {
    world.sendMessage("§7[Chaos] Systems initialized");
  } catch {}
}
