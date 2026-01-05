// scripts/chaos/bootstrap/startSystems.js
import { startLinkVision } from "../systems/linkVision.js";
import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";

export function startSystems() {
  startLinkVision();
  startCleanupOnBreak();
  startBeamSimV0();
  startFxQueue();
}
