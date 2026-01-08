// scripts/chaos/features/links/beam/queue.js
import {
  BEAM_ID,
  PRISM_ID,
  CRYSTALLIZER_ID,
} from "./config.js";
import { isPrismBlock } from "../transfer/config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key } from "./storage.js";

const pendingInputs = [];
const pendingInputsSet = new Set();

const pendingRelays = [];
const pendingRelaysSet = new Set();

const pendingValidations = [];
const pendingValidationsSet = new Set();

export function enqueueInputForRescan(inputKey) {
  if (!inputKey) return;
  if (pendingInputsSet.has(inputKey)) return;
  pendingInputsSet.add(inputKey);
  pendingInputs.push(inputKey);
}

export function enqueueBeamValidation(beamKey) {
  if (!beamKey) return;
  if (pendingValidationsSet.has(beamKey)) return;
  pendingValidationsSet.add(beamKey);
  pendingValidations.push(beamKey);
}

export function enqueueRelayForRescan(prismKey) {
  if (!prismKey) return;
  if (pendingRelaysSet.has(prismKey)) return;
  pendingRelaysSet.add(prismKey);
  pendingRelays.push(prismKey);
}

export function takePendingInput() {
  const keyVal = pendingInputs.shift();
  if (keyVal) pendingInputsSet.delete(keyVal);
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
  return pendingInputs.length > 0;
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
    if (isPrismBlock(b) || b?.typeId === CRYSTALLIZER_ID) {
      enqueueRelayForRescan(key(dim.id, x, y, z));
    }
  }
}

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
      if (id === PRISM_ID) continue; // Prisms are pass-through
      if (id === CRYSTALLIZER_ID) break; // Crystallizers stop
      if (id === "minecraft:air") break;
      break;
    }
  }
}
