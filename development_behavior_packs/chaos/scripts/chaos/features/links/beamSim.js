// scripts/chaos/beamSim.js
import { world, system } from "@minecraft/server";
import {
  BEAM_ID,
  INPUTS_PER_TICK,
  RELAYS_PER_TICK,
  VALIDATIONS_PER_TICK,
  TICK_INTERVAL,
} from "./beam/config.js";
import { isPrismBlock } from "./transfer/config.js";
import { loadBeamsMap, saveBeamsMap, parseKey, getDimensionById } from "./beam/storage.js";
import { isBeamStillValid } from "./beam/validation.js";
import { rebuildOrRemoveAllDeterministically, rebuildPrismBeams, rebuildRelayBeams } from "./beam/rebuild.js";
import { registerBeamEvents } from "./beam/events.js";
import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  hasPendingInputs,
  hasPendingRelays,
  hasPendingValidations,
  takePendingInput,
  takePendingRelay,
  takePendingValidation,
} from "./beam/queue.js";

export function startBeamSimV0(invalidateCachesFn = null) {
  rebuildOrRemoveAllDeterministically(world);
  registerBeamEvents(world, system, invalidateCachesFn);

  system.runInterval(() => {
    const map = loadBeamsMap(world);
    let changed = false;

    let validationBudget = VALIDATIONS_PER_TICK;
    while (validationBudget-- > 0 && hasPendingValidations()) {
      const beamKey = takePendingValidation();
      if (!beamKey) continue;

      const p = parseKey(beamKey);
      if (!p) continue;
      const dim = getDimensionById(world, p.dimId);
      if (!dim) continue;

      const loc = { x: p.x, y: p.y, z: p.z };
      if (isBeamStillValid(dim, loc)) continue;

      const b = dim.getBlock(loc);
      if (b?.typeId === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, loc);
        enqueueAdjacentPrisms(dim, loc);
      }
    }

    // Scan prisms for beam placement (all prisms can emit beams)
    let prismBudget = INPUTS_PER_TICK; // Reuse budget constant
    while (prismBudget-- > 0 && hasPendingInputs()) {
      const prismKey = takePendingInput(); // Reuse queue for prisms
      if (!prismKey) continue;

      const entry = map[prismKey];
      if (!entry) continue;

      const dim = getDimensionById(world, entry.dimId);
      if (!dim) continue;

      const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
      // Only prisms now
      if (!pb || !isPrismBlock(pb)) {
        delete map[prismKey];
        changed = true;
        continue;
      }

      rebuildPrismBeams(world, entry);
      map[prismKey] = entry;
      changed = true;
    }

    let relayBudget = RELAYS_PER_TICK;
    while (relayBudget-- > 0 && hasPendingRelays()) {
      const prismKey = takePendingRelay();
      if (!prismKey) continue;

      const entry = map[prismKey] || (() => {
        const p = parseKey(prismKey);
        if (!p) return null;
        return { dimId: p.dimId, x: p.x, y: p.y, z: p.z, beams: [], kind: "prism" };
      })();
      if (!entry) continue;

      rebuildRelayBeams(world, entry, map);
      changed = true;
    }

    if (changed) saveBeamsMap(world, map);
  }, TICK_INTERVAL);
}
