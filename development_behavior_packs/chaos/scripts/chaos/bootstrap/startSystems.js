// scripts/chaos/bootstrap/startSystems.js
import { startLinkVision } from "../systems/linkVision.js";
import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";

export function startSystems() {
  // Start FX queue first so spawns don't stall if later systems throw.
  try { startFxQueue(); } catch {}
  try { startLinkVision(); } catch {}
  try { startCleanupOnBreak(); } catch {}
  try { startFilterInteract(); } catch {}
  try { startBeamSimV0(); } catch {}
}
