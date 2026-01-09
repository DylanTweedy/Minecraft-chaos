// scripts/chaos/bootstrap/startSystems.js
import { world, system } from "@minecraft/server";
import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";
import { startCrystallizerSystem } from "../crystallizer.js";
import { startPrestigeSystem } from "../prestige.js";
import { startDeathmarkSystem } from "../deathmark.js";
import { startInsightObservation } from "../systems/insightObservation.js";
import { initializeScriptLoader, registerScript, markScriptLoaded, notifyPlayers, startPlayerJoinNotifier } from "../core/scriptLoader.js";
import { loadDebugSettings } from "../core/debugGroups.js";

export function startSystems() {
  // Initialize script loader with world and system
  initializeScriptLoader(world, system);
  
  // Load persistent debug settings after a small delay to ensure world is ready
  system.runTimeout(() => {
    try {
      loadDebugSettings();
    } catch {}
  }, 1);
  
  // Register all scripts
  registerScript("FX Queue");
  registerScript("Cleanup on Break");
  registerScript("Filter Interact");
  registerScript("Beam Simulation");
  registerScript("Crystallizer");
  registerScript("Prestige");
  registerScript("Deathmark");
  registerScript("Insight Observation");
  
  // Start FX queue first so spawns don't stall if later systems throw.
  try { 
    startFxQueue(); 
    markScriptLoaded("FX Queue");
  } catch {}
  
  try { 
    startCleanupOnBreak(); 
    markScriptLoaded("Cleanup on Break");
  } catch {}
  
  try { 
    startFilterInteract(); 
    markScriptLoaded("Filter Interact");
  } catch {}
  
  try { 
    startBeamSimV0(); 
    markScriptLoaded("Beam Simulation");
  } catch {}
  
  try { 
    startCrystallizerSystem(); 
    markScriptLoaded("Crystallizer");
  } catch {}
  
  try { 
    startPrestigeSystem(); 
    markScriptLoaded("Prestige");
  } catch {}
  
  try { 
    startDeathmarkSystem(world, system); 
    markScriptLoaded("Deathmark");
  } catch {}
  
  try { 
    startInsightObservation(); 
    markScriptLoaded("Insight Observation");
  } catch {}
  
  // Start player join notifier (for new players joining)
  startPlayerJoinNotifier();
  
  // Notify existing players after a delay (for reload scenarios)
  // This ensures players already in the world get notified on reload
  system.runTimeout(() => {
    notifyPlayers();
  }, 40); // Longer delay to ensure all systems are loaded and observation system has updated groups
}
