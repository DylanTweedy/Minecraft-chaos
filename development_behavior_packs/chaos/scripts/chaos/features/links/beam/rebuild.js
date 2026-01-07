// scripts/chaos/features/links/beam/rebuild.js
import { BlockPermutation } from "@minecraft/server";
import {
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
  CRYSTALLIZER_ID,
  BEAM_ID,
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
} from "./config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key, parseKey, getDimensionById, loadBeamsMap, saveBeamsMap } from "./storage.js";
import { axisForDir, beamAxisMatchesDir } from "./axis.js";
import { prismHasRelaySource } from "./validation.js";
import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  enqueueRelayForRescan,
  enqueueInputForRescan,
} from "./queue.js";

function placeBeamIfAir(dim, x, y, z, axis) {
  try {
    const b = dim.getBlock({ x, y, z });
    if (!b || b.typeId !== "minecraft:air") return false;

    const safeAxis = (axis === AXIS_Y ? AXIS_Y : (axis === AXIS_Z ? AXIS_Z : AXIS_X));
    const perm = BlockPermutation.resolve(BEAM_ID, { "chaos:axis": safeAxis });
    b.setPermutation(perm);
    return true;
  } catch {
    return false;
  }
}

export function removeRecordedBeams(world, entry) {
  try {
    const dim = getDimensionById(world, entry?.dimId);
    if (!dim) return;

    const recorded = Array.isArray(entry?.beams) ? entry.beams : [];
    for (const bk of recorded) {
      const p = parseKey(bk);
      if (!p) continue;
      if (p.dimId !== entry.dimId) continue;
      const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
      if (b?.typeId === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, p);
        enqueueAdjacentPrisms(dim, p);
      }
    }

    // legacy cleanup (rays.blocks)
    const rays = Array.isArray(entry?.rays) ? entry.rays : [];
    for (const r of rays) {
      const blocks = Array.isArray(r?.blocks) ? r.blocks : [];
      for (const bk of blocks) {
        const p = parseKey(bk);
        if (!p) continue;
        if (p.dimId !== entry.dimId) continue;
        const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
        if (b?.typeId === BEAM_ID) {
          b.setType("minecraft:air");
          enqueueAdjacentBeams(dim, p);
          enqueueAdjacentPrisms(dim, p);
        }
      }
    }
  } catch {
    // ignore
  }
}

function scanOutputsInDir(dim, loc, dx, dy, dz) {
  const outputs = [];
  let prismDist = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === OUTPUT_ID) {
      outputs.push(i);
      continue;
    }
    if (id === INPUT_ID) {
      outputs.push(i);
      continue;
    }
    if (id === PRISM_ID || id === CRYSTALLIZER_ID) {
      prismDist = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    break;
  }
  return { outputs, prismDist };
}

function recordBeamKey(recorded, recordedSet, dimId, x, y, z) {
  const k = key(dimId, x, y, z);
  if (recordedSet.has(k)) return;
  recordedSet.add(k);
  recorded.push(k);
}

function fillBeamsToDistance(dim, loc, dx, dy, dz, dist, axis, recorded, recordedSet) {
  for (let i = 1; i < dist; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === "minecraft:air") {
      if (placeBeamIfAir(dim, x, y, z, axis)) recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
      continue;
    }

    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) {
        recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
        continue;
      }
      break;
    }

    if (id === OUTPUT_ID) continue;
    if (id === INPUT_ID) continue;
    if (id === PRISM_ID || id === CRYSTALLIZER_ID) break;

    break;
  }
}

export function rebuildInputBeams(world, entry) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!ib || ib.typeId !== INPUT_ID) return;

  removeRecordedBeams(world, entry);

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  const recorded = [];
  const recordedSet = new Set();
  for (const d of dirs) {
    const res = scanOutputsInDir(dim, entry, d.dx, d.dy, d.dz);
    const maxOut = res.outputs.length > 0 ? res.outputs[res.outputs.length - 1] : 0;
    const axis = axisForDir(d.dx, d.dy, d.dz);
    if (maxOut > 0) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, maxOut, axis, recorded, recordedSet);
    }
    if (res.prismDist > 1) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, res.prismDist, axis, recorded, recordedSet);
      const prismKey = key(entry.dimId, entry.x + d.dx * res.prismDist, entry.y + d.dy * res.prismDist, entry.z + d.dz * res.prismDist);
      enqueueRelayForRescan(prismKey);
    }
  }

  entry.beams = recorded;
  delete entry.rays;
}

export function rebuildRelayBeams(world, entry, map) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!pb || (pb.typeId !== PRISM_ID && pb.typeId !== CRYSTALLIZER_ID)) {
    removeRecordedBeams(world, entry);
    delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
    return;
  }

  if (!prismHasRelaySource(dim, entry)) {
    removeRecordedBeams(world, entry);
    delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
    return;
  }

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  const recorded = [];
  const recordedSet = new Set();
  for (const d of dirs) {
    const res = scanOutputsInDir(dim, entry, d.dx, d.dy, d.dz);
    const maxOut = res.outputs.length > 0 ? res.outputs[res.outputs.length - 1] : 0;
    const axis = axisForDir(d.dx, d.dy, d.dz);
    if (maxOut > 0) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, maxOut, axis, recorded, recordedSet);
    }
    if (res.prismDist > 1) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, res.prismDist, axis, recorded, recordedSet);
      const prismKey = key(entry.dimId, entry.x + d.dx * res.prismDist, entry.y + d.dy * res.prismDist, entry.z + d.dz * res.prismDist);
      enqueueRelayForRescan(prismKey);
    }
  }

  entry.beams = recorded;
  entry.kind = "prism";
  delete entry.rays;
  map[key(entry.dimId, entry.x, entry.y, entry.z)] = entry;
}

export function rebuildOrRemoveAllDeterministically(world) {
  const map = loadBeamsMap(world);
  let changed = false;

  for (const inputKey of Object.keys(map)) {
    const entry = map[inputKey];
    if (!entry || typeof entry !== "object") {
      delete map[inputKey];
      changed = true;
      continue;
    }

    const dim = getDimensionById(world, entry.dimId);
    if (!dim) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    removeRecordedBeams(world, entry);

    const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
    if (!ib || ib.typeId !== INPUT_ID) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    entry.beams = [];
    entry.kind = "input";
    delete entry.rays;
    map[inputKey] = entry;
    changed = true;

    enqueueInputForRescan(inputKey);
  }

  if (changed) saveBeamsMap(world, map);
}

export function clearBeamsFromBreak(world, dim, loc) {
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
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, { x, y, z });
        enqueueAdjacentPrisms(dim, { x, y, z });
        continue;
      }
      if (id === "minecraft:air") break;
      if (id === OUTPUT_ID) break;
      if (id === INPUT_ID) break;
      if (id === PRISM_ID || id === CRYSTALLIZER_ID) break;
      break;
    }
  }
}
