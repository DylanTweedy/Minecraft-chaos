// scripts/chaos/features/links/beam/rebuild.js
import { BlockPermutation } from "@minecraft/server";
import {
  CRYSTALLIZER_ID,
  BEAM_ID,
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
} from "./config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key, parseKey, getDimensionById, loadBeamsMap, saveBeamsMap } from "./storage.js";
import { axisForDir, beamAxisMatchesDir } from "./axis.js";
import { isRelayBlock } from "./validation.js";
import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  enqueueRelayForRescan,
  enqueueInputForRescan,
} from "./queue.js";
import { getPrismTier, isPrismBlock } from "../transfer/config.js";

function getTierFromBlock(block) {
  if (!block) return 1;
  
  // Beams use chaos:level state, prisms use separate block IDs
  if (block.typeId === BEAM_ID) {
    try {
      const level = block?.permutation?.getState("chaos:level");
      if (Number.isFinite(level)) return Math.max(1, Math.min(5, level | 0));
    } catch {
      // ignore
    }
    return 1;
  }
  
  // Prisms now use separate block IDs (prism_1, prism_2, etc.) instead of state
  return getPrismTier(block);
}

function placeBeamIfAir(dim, x, y, z, axis, tier = 1) {
  try {
    const b = dim.getBlock({ x, y, z });
    if (!b || b.typeId !== "minecraft:air") return false;

    const safeAxis = (axis === AXIS_Y ? AXIS_Y : (axis === AXIS_Z ? AXIS_Z : AXIS_X));
    const safeTier = Math.max(1, Math.min(5, tier | 0));
    const perm = BlockPermutation.resolve(BEAM_ID, { "chaos:axis": safeAxis, "chaos:level": safeTier });
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

// Scan for prisms (or crystallizers) in a direction - returns distances to valid targets
function scanPrismsInDir(dim, loc, dx, dy, dz) {
  const prismDists = [];
  let closestPrismDist = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    // All prisms are valid connection points
    if (isPrismBlock(b)) {
      prismDists.push(i);
      if (closestPrismDist === 0) closestPrismDist = i;
      continue; // Continue scanning - there might be more prisms
    }
    if (id === CRYSTALLIZER_ID) {
      prismDists.push(i);
      if (closestPrismDist === 0) closestPrismDist = i;
      break; // Crystallizers stop scanning
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    break;
  }
  return { prismDists, closestPrismDist };
}

function recordBeamKey(recorded, recordedSet, dimId, x, y, z) {
  const k = key(dimId, x, y, z);
  if (recordedSet.has(k)) return;
  recordedSet.add(k);
  recorded.push(k);
}

function fillBeamsToDistance(dim, loc, dx, dy, dz, dist, axis, recorded, recordedSet, tier = 1) {
  for (let i = 1; i < dist; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === "minecraft:air") {
      if (placeBeamIfAir(dim, x, y, z, axis, tier)) recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
      continue;
    }

    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) {
        // Higher tier beams override lower tier beams
        const beamTier = getTierFromBlock(b);
        const newTier = Math.max(beamTier, tier); // Use the higher tier
        if (newTier !== beamTier) {
          try {
            const perm = b.permutation.withState("chaos:level", newTier);
            b.setPermutation(perm);
          } catch {
            // ignore
          }
        }
        recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
        continue;
      }
      break;
    }

    if (isPrismBlock(b)) continue; // Prisms are pass-through for beam placement
    if (id === CRYSTALLIZER_ID) break; // Crystallizers stop beam placement

    break;
  }
}

// Rebuild beams for a prism - each prism emits beams of its tier to nearby prisms
export function rebuildPrismBeams(world, entry, providedMap = null) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const prismBlock = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!prismBlock || !isPrismBlock(prismBlock)) return;

  removeRecordedBeams(world, entry);

  const sourceTier = getTierFromBlock(prismBlock);

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
  const map = providedMap || loadBeamsMap(world);
  let mapChanged = false;
  
  for (const d of dirs) {
    const res = scanPrismsInDir(dim, { x: entry.x, y: entry.y, z: entry.z }, d.dx, d.dy, d.dz);
    
    // Place beams to the closest prism (or to each prism if multiple)
    // Higher tier beams will override lower tier beams during placement
    const targetDist = res.closestPrismDist;
    if (targetDist > 0) {
      const axis = axisForDir(d.dx, d.dy, d.dz);
      fillBeamsToDistance(dim, { x: entry.x, y: entry.y, z: entry.z }, d.dx, d.dy, d.dz, targetDist, axis, recorded, recordedSet, sourceTier);
      
      // Ensure target prism is in the map (discover existing prisms)
      const targetX = entry.x + d.dx * targetDist;
      const targetY = entry.y + d.dy * targetDist;
      const targetZ = entry.z + d.dz * targetDist;
      const targetKey = key(entry.dimId, targetX, targetY, targetZ);
      if (!map[targetKey]) {
        const targetBlock = dim.getBlock({ x: targetX, y: targetY, z: targetZ });
        if (targetBlock && isPrismBlock(targetBlock)) {
          map[targetKey] = { dimId: entry.dimId, x: targetX, y: targetY, z: targetZ, beams: [], kind: "prism" };
          mapChanged = true;
          enqueueInputForRescan(targetKey);
        }
      }
      
      // Enqueue the target prism for rescan (it may need to update its beams with higher tier)
      enqueueRelayForRescan(targetKey);
    }
  }
  
  // Only save if we loaded the map ourselves (not if it was provided)
  if (mapChanged && !providedMap) saveBeamsMap(world, map);

  entry.beams = recorded;
  entry.kind = "prism";
  delete entry.rays;
}

// Legacy function name for backwards compatibility with existing code
export function rebuildInputBeams(world, entry) {
  return rebuildPrismBeams(world, entry);
}

export function rebuildRelayBeams(world, entry, map) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  // Only prisms now (crystallizers are handled separately)
  if (!pb || !isPrismBlock(pb)) {
    removeRecordedBeams(world, entry);
    const entryKey = key(entry.dimId, entry.x, entry.y, entry.z);
    delete map[entryKey];
    return;
  }

  // Ensure entry is in map (in case it was just discovered)
  const entryKey = key(entry.dimId, entry.x, entry.y, entry.z);
  if (!map[entryKey]) {
    map[entryKey] = entry;
  }

  // In unified system, rebuildRelayBeams is called when adjacent prisms change
  // Use the same logic as rebuildPrismBeams - rebuild beams to nearby prisms
  // No source check needed - all prisms can emit beams
  // Pass the map so rebuildPrismBeams can discover and add new prisms
  rebuildPrismBeams(world, entry, map);
  
  // Update the map entry (rebuildPrismBeams may have modified entry.beams)
  map[entryKey] = entry;
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
    // Only prisms are valid now
    if (!ib || !isPrismBlock(ib)) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    entry.beams = [];
    entry.kind = "prism";
    delete entry.rays;
    map[inputKey] = entry;
    changed = true;

    // Enqueue for initial beam building (uses pendingInputs queue)
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
      if (isPrismBlock(b) || id === CRYSTALLIZER_ID) break;
      break;
    }
  }
}
