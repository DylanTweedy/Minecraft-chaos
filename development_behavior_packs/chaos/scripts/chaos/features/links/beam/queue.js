// scripts/chaos/features/links/beam/queue.js
import {
  BEAM_ID,
  CRYSTALLIZER_ID,
  isPrismId,
} from "./config.js";

import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key } from "./storage.js";

// NOTE:
// "Inputs" are now prisms (beam sources / relays).
// We keep the exported function names for now to avoid churn,
// but internally treat these as prism queues.

const pendingPrisms = [];
const pendingPrismsSet = new Set();

const pendingRelays = [];
const pendingRelaysSet = new Set();

const pendingValidations = [];
const pendingValidationsSet = new Set();

export function enqueueInputForRescan(prismKey) {
  if (!prismKey) return;
  if (pendingPrismsSet.has(prismKey)) return;
  pendingPrismsSet.add(prismKey);
  pendingPrisms.push(prismKey);
}

export function enqueueBeamValidation(beamKey) {
  if (!beamKey) return;
  if (pendingValidationsSet.has(beamKey)) return;
  pendingValidationsSet.add(beamKey);
  pendingValidations.push(beamKey);
}

export function enqueueRelayForRescan(nodeKey) {
  if (!nodeKey) return;
  if (pendingRelaysSet.has(nodeKey)) return;
  pendingRelaysSet.add(nodeKey);
  pendingRelays.push(nodeKey);
}

export function takePendingInput() {
  const keyVal = pendingPrisms.shift();
  if (keyVal) pendingPrismsSet.delete(keyVal);
  return keyVal || null;
}

export function takePendingRelay() {
  const keyVal = pendingRelays.shift();
  if (keyVal) pendingRelaysSet.delete(keyVal);
  return keyVal || null;
}

export function takePendingValidation() {
  const keyVal = pendingValidations.shift();
  if (keyVal) pendingValidationsSet.delete(keyVal);
  return keyVal || null;
}

export function hasPendingInputs() {
  return pendingPrisms.length > 0;
}

export function hasPendingRelays() {
  return pendingRelays.length > 0;
}

export function hasPendingValidations() {
  return pendingValidations.length > 0;
}

export function enqueueAdjacentBeams(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  for (const d of dirs) {
    const x = loc.x + d.dx;
    const y = loc.y + d.dy;
    const z = loc.z + d.dz;
    const b = dim.getBlock({ x, y, z });
    if (b?.typeId === BEAM_ID) {
      enqueueBeamValidation(key(dim.id, x, y, z));
    }
  }
}

/**
 * Adjacent "nodes" that may need a rebuild:
 * - prisms (relays + beam sources)
 * - crystallizers (endpoints)
 */
export function enqueueAdjacentPrisms(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  for (const d of dirs) {
    const x = loc.x + d.dx;
    const y = loc.y + d.dy;
    const z = loc.z + d.dz;
    const b = dim.getBlock({ x, y, z });

    const id = b?.typeId;
    if (isPrismId(id) || id === CRYSTALLIZER_ID) {
      enqueueRelayForRescan(key(dim.id, x, y, z));
    }
  }
}

/**
 * Enqueue all beam segments in straight lines until a non-air/non-beam block is hit.
 * We do NOT treat prisms as pass-through anymore for scanning purposes here;
 * hitting a prism/crystallizer should stop the scan in that direction.
 */
export function enqueueBeamsInLine(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;

      const b = dim.getBlock({ x, y, z });
      if (!b) break;

      const id = b.typeId;

      if (id === BEAM_ID) {
        enqueueBeamValidation(key(dim.id, x, y, z));
        continue;
      }

      // Stop at endpoints/relays or any other non-air block
      if (isPrismId(id) || id === CRYSTALLIZER_ID) break;
      if (id === "minecraft:air") break;
      break;
    }
  }
}
