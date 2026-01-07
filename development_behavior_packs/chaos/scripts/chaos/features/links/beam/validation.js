// scripts/chaos/features/links/beam/validation.js
import {
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
  CRYSTALLIZER_ID,
  BEAM_ID,
  isPassThrough,
} from "./config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { beamAxisMatchesDir, getBeamAxis, beamDirsForAxis } from "./axis.js";

function prismHasDirectSource(dim, loc) {
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
    if (b.typeId === INPUT_ID || b.typeId === OUTPUT_ID || b.typeId === CRYSTALLIZER_ID) return true;
  }
  return false;
}

function prismHasRelaySource(dim, loc) {
  if (prismHasDirectSource(dim, loc)) return true;

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
    if (b?.typeId !== PRISM_ID && b?.typeId !== CRYSTALLIZER_ID) continue;
    if (prismHasDirectSource(dim, b.location)) return true;
  }
  return false;
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
    if (id === OUTPUT_ID || id === PRISM_ID || id === CRYSTALLIZER_ID || id === INPUT_ID) {
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

function beamValidFromPrism(dim, prismLoc, dx, dy, dz, beamDist) {
  if (!prismHasRelaySource(dim, prismLoc)) return false;

  let farthestNode = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = prismLoc.x + dx * i;
    const y = prismLoc.y + dy * i;
    const z = prismLoc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === OUTPUT_ID || id === PRISM_ID || id === CRYSTALLIZER_ID || id === INPUT_ID) {
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

export function isBeamStillValid(dim, loc) {
  const b = dim.getBlock(loc);
  if (!b || b.typeId !== BEAM_ID) return false;

  const axis = getBeamAxis(b);
  const dirs = beamDirsForAxis(axis);

  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const scan = dim.getBlock({ x, y, z });
      if (!scan) break;

      const id = scan.typeId;
      if (id === INPUT_ID) {
        if (beamValidFromInput(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) return true;
        break;
      }
      if (id === PRISM_ID || id === CRYSTALLIZER_ID) {
        if (beamValidFromPrism(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) return true;
        break;
      }
      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, d.dx, d.dy, d.dz)) continue;
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
  }

  return false;
}

export { prismHasRelaySource, prismHasDirectSource };
