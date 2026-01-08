// scripts/chaos/features/links/beam/rebuild.js
import { BlockPermutation } from "@minecraft/server";
import {
  CRYSTALLIZER_ID,
  BEAM_ID,
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
} from "./config.js";
import { getPrismTierFromTypeId, isPrismBlock } from "../transfer/config.js";
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

function getTierFromBlock(block) {
  try {
    if (!block) return 1;
    // Extract tier from block typeId
    if (isPrismBlock(block)) {
      return getPrismTierFromTypeId(block.typeId);
    }
  } catch {
    // ignore
  }
  return 1;
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

    // Remove beams on-demand from connections
    const connections = Array.isArray(entry?.connections) ? entry.connections : [];
    for (const targetKey of connections) {
      const targetPos = parseKey(targetKey);
      if (!targetPos || targetPos.dimId !== entry.dimId) continue;
      
      // Remove beams between this prism and target (rebuild on-demand to remove)
      removeBeamsBetweenPrisms(world, entry, targetPos);
    }
  } catch {
    // ignore
  }
}

// Remove beams on-demand between two prisms
function removeBeamsBetweenPrisms(world, sourceEntry, targetPos) {
  try {
    const dim = getDimensionById(world, sourceEntry?.dimId);
    if (!dim || sourceEntry.dimId !== targetPos.dimId) return;
    
    const dx = targetPos.x - sourceEntry.x;
    const dy = targetPos.y - sourceEntry.y;
    const dz = targetPos.z - sourceEntry.z;
    
    // Only handle straight lines (one axis only)
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const absDz = Math.abs(dz);
    
    let dirX = 0, dirY = 0, dirZ = 0;
    let dist = 0;
    
    if (absDx > 0 && absDy === 0 && absDz === 0) {
      dirX = dx > 0 ? 1 : -1;
      dist = absDx;
    } else if (absDy > 0 && absDx === 0 && absDz === 0) {
      dirY = dy > 0 ? 1 : -1;
      dist = absDy;
    } else if (absDz > 0 && absDx === 0 && absDy === 0) {
      dirZ = dz > 0 ? 1 : -1;
      dist = absDz;
    } else {
      // Not a straight line - skip
      return;
    }
    
    if (dist <= 1) return; // Adjacent blocks, no beams to remove
    
    // Remove beams along the path (excluding source and target positions)
    for (let i = 1; i < dist; i++) {
      const x = sourceEntry.x + dirX * i;
      const y = sourceEntry.y + dirY * i;
      const z = sourceEntry.z + dirZ * i;
      
      const b = dim.getBlock({ x, y, z });
      if (!b) break;
      
      if (b.typeId === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, { x, y, z });
        enqueueAdjacentPrisms(dim, { x, y, z });
      } else if (isPrismBlock(b) || b.typeId === CRYSTALLIZER_ID) {
        // Pass through prisms and crystallizers (both are relays)
        continue;
      } else {
        // Obstacle - stop
        break;
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
    // All prisms and crystallizers are valid connection points
    if (isPrismBlock(b) || id === CRYSTALLIZER_ID) {
      prismDists.push(i);
      if (closestPrismDist === 0) closestPrismDist = i;
      continue; // Continue scanning - there might be more prisms/crystallizers
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

// Rebuild beams on-demand between two prisms (visual only, not stored)
function rebuildBeamsBetweenPrisms(world, sourceEntry, targetPos, sourceTier) {
  try {
    const dim = getDimensionById(world, sourceEntry?.dimId);
    if (!dim || sourceEntry.dimId !== targetPos.dimId) return;
    
    const dx = targetPos.x - sourceEntry.x;
    const dy = targetPos.y - sourceEntry.y;
    const dz = targetPos.z - sourceEntry.z;
    
    // Only handle straight lines (one axis only)
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const absDz = Math.abs(dz);
    
    let dirX = 0, dirY = 0, dirZ = 0;
    let dist = 0;
    
    if (absDx > 0 && absDy === 0 && absDz === 0) {
      dirX = dx > 0 ? 1 : -1;
      dist = absDx;
    } else if (absDy > 0 && absDx === 0 && absDz === 0) {
      dirY = dy > 0 ? 1 : -1;
      dist = absDy;
    } else if (absDz > 0 && absDx === 0 && absDy === 0) {
      dirZ = dz > 0 ? 1 : -1;
      dist = absDz;
    } else {
      // Not a straight line - skip
      return;
    }
    
    if (dist <= 1) return; // Adjacent blocks, no beams needed
    
    const axis = axisForDir(dirX, dirY, dirZ);
    
    // Place/update beams along the path (excluding source and target positions)
    for (let i = 1; i < dist; i++) {
      const x = sourceEntry.x + dirX * i;
      const y = sourceEntry.y + dirY * i;
      const z = sourceEntry.z + dirZ * i;
      
      const b = dim.getBlock({ x, y, z });
      if (!b) break;
      
      const id = b.typeId;
      if (id === "minecraft:air") {
        // Place new beam
        placeBeamIfAir(dim, x, y, z, axis, sourceTier);
      } else if (id === BEAM_ID) {
        // Update existing beam tier if needed (use higher tier)
        if (beamAxisMatchesDir(b, dirX, dirY, dirZ)) {
          const beamTier = getTierFromBlock(b);
          const newTier = Math.max(beamTier, sourceTier);
          if (newTier !== beamTier) {
            try {
              // Beams don't have tiers - this code shouldn't run for beams
              // If we need to update beam tier, we'd need to replace the beam block
              // For now, skip this as beams are not tiered
            } catch {
              // ignore
            }
          }
        }
      } else if (isPrismBlock(b) || id === CRYSTALLIZER_ID) {
        // Pass through prisms and crystallizers (both are relays)
        continue;
      } else {
        // Obstacle - stop
        break;
      }
    }
  } catch {
    // ignore
  }
}

// Rebuild beams for a prism or crystallizer - they both emit beams to nearby prisms/crystallizers
export function rebuildPrismBeams(world, entry) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const block = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!block || (!isPrismBlock(block) && block.typeId !== CRYSTALLIZER_ID)) return;

  removeRecordedBeams(world, entry);

  // Crystallizers are treated as tier 1 for beam purposes
  const sourceTier = isPrismBlock(block) ? getTierFromBlock(block) : 1;
  const isCrystallizer = block.typeId === CRYSTALLIZER_ID;

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  // Store connections (target prism/crystallizer keys), not individual beam block locations
  const connections = [];
  const connectionsSet = new Set();
  
  for (const d of dirs) {
    const res = scanPrismsInDir(dim, { x: entry.x, y: entry.y, z: entry.z }, d.dx, d.dy, d.dz);
    
    // Connect to the closest prism or crystallizer in this direction
    const targetDist = res.closestPrismDist;
    if (targetDist > 0) {
      const targetX = entry.x + d.dx * targetDist;
      const targetY = entry.y + d.dy * targetDist;
      const targetZ = entry.z + d.dz * targetDist;
      const targetKey = key(entry.dimId, targetX, targetY, targetZ);
      
      // Verify target is actually a prism or crystallizer
      const targetBlock = dim.getBlock({ x: targetX, y: targetY, z: targetZ });
      if (targetBlock && (isPrismBlock(targetBlock) || targetBlock.typeId === CRYSTALLIZER_ID)) {
        // Store connection (prism/crystallizer key, not beam block locations)
        if (!connectionsSet.has(targetKey)) {
          connectionsSet.add(targetKey);
          connections.push(targetKey);
        }
        
        // Rebuild beams visually between this block and target (on-demand)
        // Use the maximum tier of both blocks to prevent tier conflicts
        // Crystallizers are treated as tier 1 for beam purposes
        const targetTier = isPrismBlock(targetBlock) ? getTierFromBlock(targetBlock) : 1;
        const beamTier = Math.max(sourceTier, targetTier);
        rebuildBeamsBetweenPrisms(world, entry, { dimId: entry.dimId, x: targetX, y: targetY, z: targetZ }, beamTier);
        
        // If source tier is higher, enqueue target for rescan to update its beams
        if (sourceTier > targetTier) {
          enqueueRelayForRescan(targetKey);
        }
      }
    }
  }

  // Store connections instead of beam block locations
  entry.connections = connections;
  entry.kind = isCrystallizer ? "crystallizer" : "prism";
}

export function rebuildInputBeams(world, entry) {
  return rebuildPrismBeams(world, entry);
}

export function rebuildRelayBeams(world, entry, map) {
  const dim = getDimensionById(world, entry?.dimId);
  if (!dim) return;

  const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!pb) {
    // Block doesn't exist - clean up entry if it exists
    if (entry) {
      removeRecordedBeams(world, entry);
      delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
    }
    return;
  }

  // Handle prisms and crystallizers - they both emit beams
  if (isPrismBlock(pb) || pb.typeId === CRYSTALLIZER_ID) {
    // In unified system, rebuildRelayBeams is called when adjacent blocks change
    // Use the same logic as rebuildPrismBeams - rebuild beams to nearby prisms/crystallizers
    // Both prisms and crystallizers can emit beams
    rebuildPrismBeams(world, entry);
    
    // Update the map entry
    map[key(entry.dimId, entry.x, entry.y, entry.z)] = entry;
    return;
  }

  // Unknown block type - clean up entry if it exists
  if (entry) {
    removeRecordedBeams(world, entry);
    delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
  }
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
    // Only prisms and crystallizers are valid now
    if (!ib || (!isPrismBlock(ib) && ib.typeId !== CRYSTALLIZER_ID)) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    // Migrate old beams array to connections if needed
    if (Array.isArray(entry.beams)) {
      delete entry.beams;
      changed = true;
    }
    
    // Ensure connections array exists and validate connections
    if (!Array.isArray(entry.connections)) {
      entry.connections = [];
      changed = true;
    } else {
      // Validate connections - remove invalid ones
      const validConnections = [];
      for (const connKey of entry.connections) {
        const connPos = parseKey(connKey);
        if (!connPos || connPos.dimId !== entry.dimId) continue;
        const connBlock = dim.getBlock({ x: connPos.x, y: connPos.y, z: connPos.z });
        if (connBlock && (isPrismBlock(connBlock) || connBlock.typeId === CRYSTALLIZER_ID)) {
          validConnections.push(connKey);
        }
      }
      if (validConnections.length !== entry.connections.length) {
        entry.connections = validConnections;
        changed = true;
      }
    }
    
    entry.kind = "prism";
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
