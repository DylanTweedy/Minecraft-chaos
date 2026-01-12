// scripts/chaos/features/links/beam/validation.js
import {
  CRYSTALLIZER_ID,
  BEAM_ID,
  isPrismId,
  isPassThroughId,
} from "./config.js";

import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { beamAxisMatchesDir, getBeamAxis, beamDirsForAxis } from "./axis.js";

/**
 * Relay endpoints for beam validity:
 * - prisms
 * - crystallizer
 *
 * NOTE: "Relay" here means "a node the beam may attach to / propagate through",
 * not "pass-through".
 */
function isRelayId(typeId) {
  return isPrismId(typeId) || typeId === CRYSTALLIZER_ID;
}

// Keep export name stable for now (other modules may import isRelayBlock)
function isRelayBlock(typeId) {
  return isRelayId(typeId);
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
    if (isRelayId(b.typeId)) return true;
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
    if (!b || !isRelayId(b.typeId)) continue;

    if (relayHasDirectSource(dim, b.location)) return true;
  }
  return false;
}

function prismHasRelaySource(dim, loc) {
  return relayHasRelaySource(dim, loc);
}

/**
 * Validate whether an existing beam segment at distance beamDist is still valid
 * given an input node position and direction.
 *
 * NOTE: This function is currently unused in isBeamStillValid(), but keep it
 * for now if other modules depend on it.
 */
function beamValidFromInput(dim, inputLoc, dx, dy, dz, beamDist) {
  let farthestOutput = 0;

  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const b = dim.getBlock({ x: inputLoc.x + dx * i, y: inputLoc.y + dy * i, z: inputLoc.z + dz * i });
    if (!b) break;

    const id = b.typeId;

    if (isRelayId(id)) {
      farthestOutput = i;
      break;
    }

    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    // Traversal
    if (isPassThroughId(id)) continue;

    break;
  }

  return farthestOutput >= beamDist;
}

/**
 * Validate beam from a relay/prism node.
 */
function beamValidFromRelay(dim, relayLoc, dx, dy, dz, beamDist) {
  if (!relayHasRelaySource(dim, relayLoc)) return false;

  let farthestNode = 0;

  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const b = dim.getBlock({ x: relayLoc.x + dx * i, y: relayLoc.y + dy * i, z: relayLoc.z + dz * i });
    if (!b) break;

    const id = b.typeId;

    if (isRelayId(id)) {
      farthestNode = i;
      break;
    }

    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    // Traversal
    if (isPassThroughId(id)) continue;

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

  // Beam segment is valid if it has a valid source and a valid target along its axis.
  for (const d of dirs) {
    let foundValidSource = false;
    let foundValidTarget = false;

    // Forward direction: find a target node
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const scan = dim.getBlock({ x: loc.x + d.dx * i, y: loc.y + d.dy * i, z: loc.z + d.dz * i });
      if (!scan) break;

      const id = scan.typeId;

      if (isRelayId(id)) {
        if (beamValidFromRelay(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) {
          foundValidTarget = true;
        }
        break;
      }

      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, d.dx, d.dy, d.dz)) continue;
        break;
      }

      if (isPassThroughId(id)) continue;
      break;
    }

    // Backward direction: find a source node
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const scan = dim.getBlock({ x: loc.x - d.dx * i, y: loc.y - d.dy * i, z: loc.z - d.dz * i });
      if (!scan) break;

      const id = scan.typeId;

      if (isRelayId(id)) {
        if (beamValidFromRelay(dim, scan.location, d.dx, d.dy, d.dz, i)) {
          foundValidSource = true;
        }
        break;
      }

      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, -d.dx, -d.dy, -d.dz)) continue;
        break;
      }

      if (isPassThroughId(id)) continue;
      break;
    }

    if (foundValidSource && foundValidTarget) return true;
  }

  return false;
}

export {
  prismHasRelaySource,
  prismHasDirectSource,
  relayHasRelaySource,
  relayHasDirectSource,
  isRelayBlock,
};
