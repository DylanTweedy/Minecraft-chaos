// scripts/chaos/features/links/beam/validation.js
import {
  CRYSTALLIZER_ID,
  BEAM_ID,
  isPassThrough,
} from "./config.js";
import { isPrismBlock } from "../transfer/config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { beamAxisMatchesDir, getBeamAxis, beamDirsForAxis } from "./axis.js";

function isRelayBlock(typeId) {
  return isPrismBlock({ typeId }) || typeId === CRYSTALLIZER_ID;
}

function relayHasDirectSource(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
    if (!b) continue;
    if (b.typeId === BEAM_ID && beamAxisMatchesDir(b, d.dx, d.dy, d.dz)) return true;
    if (isRelayBlock(b.typeId)) return true;
  }
  return false;
}

function prismHasDirectSource(dim, loc) {
  return relayHasDirectSource(dim, loc);
}

function relayHasRelaySource(dim, loc) {
  if (relayHasDirectSource(dim, loc)) return true;

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
    if (!b || !isRelayBlock(b.typeId)) continue;
    if (relayHasDirectSource(dim, b.location)) return true;
  }
  return false;
}

function prismHasRelaySource(dim, loc) {
  return relayHasRelaySource(dim, loc);
}

function beamValidFromInput(dim, inputLoc, dx, dy, dz, beamDist) {
  let farthestOutput = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = inputLoc.x + dx * i;
    const y = inputLoc.y + dy * i;
    const z = inputLoc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (isPrismBlock(b) || id === CRYSTALLIZER_ID) {
      farthestOutput = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    break;
  }
  return farthestOutput >= beamDist;
}

function beamValidFromRelay(dim, relayLoc, dx, dy, dz, beamDist) {
  if (!relayHasRelaySource(dim, relayLoc)) return false;

  let farthestNode = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = relayLoc.x + dx * i;
    const y = relayLoc.y + dy * i;
    const z = relayLoc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (isRelayBlock(id)) {
      farthestNode = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }
    break;
  }
  return farthestNode >= beamDist;
}

function beamValidFromPrism(dim, prismLoc, dx, dy, dz, beamDist) {
  return beamValidFromRelay(dim, prismLoc, dx, dy, dz, beamDist);
}

export function isBeamStillValid(dim, loc) {
  const b = dim.getBlock(loc);
  if (!b || b.typeId !== BEAM_ID) return false;

  const axis = getBeamAxis(b);
  const dirs = beamDirsForAxis(axis);

  // Check both directions along the beam axis
  for (const d of dirs) {
    let foundValidSource = false;
    let foundValidTarget = false;
    
    // Check forward direction
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const scan = dim.getBlock({ x, y, z });
      if (!scan) break;

      const id = scan.typeId;
      // All prisms are valid sources/targets
      if (isPrismBlock(scan)) {
        if (beamValidFromRelay(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) {
          foundValidTarget = true;
          break;
        }
        break;
      }
      if (isRelayBlock(id)) {
        if (beamValidFromRelay(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) {
          foundValidTarget = true;
          break;
        }
        break;
      }
      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, d.dx, d.dy, d.dz)) continue;
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
    
    // Check backward direction
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x - d.dx * i;
      const y = loc.y - d.dy * i;
      const z = loc.z - d.dz * i;
      const scan = dim.getBlock({ x, y, z });
      if (!scan) break;

      const id = scan.typeId;
      // All prisms are valid sources/targets
      if (isPrismBlock(scan)) {
        if (beamValidFromRelay(dim, scan.location, d.dx, d.dy, d.dz, i)) {
          foundValidSource = true;
          break;
        }
        break;
      }
      if (isRelayBlock(id)) {
        if (beamValidFromRelay(dim, scan.location, d.dx, d.dy, d.dz, i)) {
          foundValidSource = true;
          break;
        }
        break;
      }
      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, -d.dx, -d.dy, -d.dz)) continue;
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
    
    if (foundValidSource && foundValidTarget) return true;
  }

  return false;
}

export { prismHasRelaySource, prismHasDirectSource, relayHasRelaySource, relayHasDirectSource, isRelayBlock };
