// scripts/chaos/features/links/beam/beamSim.js
import { world, system } from "@minecraft/server";

import {
  BEAM_ID,
  INPUTS_PER_TICK,
  RELAYS_PER_TICK,
  VALIDATIONS_PER_TICK,
  TICK_INTERVAL,
  isPrismId,
} from "./config.js";

import { loadBeamsMap, saveBeamsMap, parseKey, getDimensionById } from "./storage.js";
import { isBeamStillValid } from "./validation.js";
import { rebuildOrRemoveAllDeterministically, rebuildPrismBeams, rebuildRelayBeams } from "./rebuild.js";
import { registerBeamEvents } from "./events.js";

import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  hasPendingInputs,
  hasPendingRelays,
  hasPendingValidations,
  takePendingInput,
  takePendingRelay,
  takePendingValidation,
} from "./queue.js";

export function startBeamSimV0(invalidateCachesFn = null) {
  rebuildOrRemoveAllDeterministically(world);
  registerBeamEvents(world, system, invalidateCachesFn);

  system.runInterval(() => {
    const map = loadBeamsMap(world);
    let changed = false;

    // Validate beams (remove broken beam blocks)
    let validationBudget = VALIDATIONS_PER_TICK;
    while (validationBudget-- > 0 && hasPendingValidations()) {
      const beamKey = takePendingValidation();
      if (!beamKey) continue;

      const p = parseKey(beamKey);
      if (!p) continue;

      const dim = getDimensionById(world, p.dimId);
      if (!dim) continue;

      const loc = { x: p.x, y: p.y, z: p.z };

      // Still a valid beam segment? Great, move on.
      if (isBeamStillValid(dim, loc)) continue;

      // If the block is actually a beam, delete it and enqueue neighbors.
      const b = dim.getBlock(loc);
      if (b?.typeId === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, loc);
        enqueueAdjacentPrisms(dim, loc);
      }
    }

    // Scan prisms for beam placement (all prisms can emit beams)
    let prismBudget = INPUTS_PER_TICK;
    while (prismBudget-- > 0 && hasPendingInputs()) {
      const prismKey = takePendingInput();
      if (!prismKey) continue;

      const entry = map[prismKey];
      if (!entry) continue;

      const dim = getDimensionById(world, entry.dimId);
      if (!dim) continue;

      const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });

      // Prism-only: if the source prism is gone, remove its entry.
      if (!pb || !isPrismId(pb.typeId)) {
        delete map[prismKey];
        changed = true;
        continue;
      }

      rebuildPrismBeams(world, entry);
      map[prismKey] = entry;
      changed = true;
    }

    // Relay rebuilds (path segments / propagation)
    let relayBudget = RELAYS_PER_TICK;
    while (relayBudget-- > 0 && hasPendingRelays()) {
      const prismKey = takePendingRelay();
      if (!prismKey) continue;

      const entry =
        map[prismKey] ||
        (() => {
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
