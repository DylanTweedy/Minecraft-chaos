import { world } from "@minecraft/server";
import { log } from "./log.js";

/**
 * Returns {x,y,z} of the block the node is mounted to (the inventory block), or null.
 */
export function getMountedBlockPos(dimension, nodePos) {
  const block = dimension.getBlock(nodePos);
  if (!block) return null;

  const perm = block.permutation;

  // Case A: block_face string state
  const face = safeGetState(perm, "minecraft:block_face");
  if (typeof face === "string") {
    const dir = oppositeDir(face);
    if (!dir) return null;
    const v = dirToVec(dir);
    return { x: nodePos.x + v.x, y: nodePos.y + v.y, z: nodePos.z + v.z };
  }

  // Case B: facing_direction numeric state (0..5)
  const fd = safeGetState(perm, "minecraft:facing_direction");
  if (typeof fd === "number") {
    const dir = facingDirNumberToName(fd);
    const opp = oppositeDir(dir);
    const v = dirToVec(opp);
    return { x: nodePos.x + v.x, y: nodePos.y + v.y, z: nodePos.z + v.z };
  }

  return null;
}

export function getAttachedContainer(dimension, nodePos) {
  const mountedPos = getMountedBlockPos(dimension, nodePos);
  if (!mountedPos) return null;

  let mountedBlock;
  try {
    mountedBlock = dimension.getBlock(mountedPos);
  } catch (e) {
    log(`Mounted block lookup failed (unloaded/out of bounds). ${e}`);
    return null;
  }
  if (!mountedBlock) return null;

  // Important: this can throw on unloaded chunks in some cases
  try {
    const inv = mountedBlock.getComponent("minecraft:inventory");
    if (!inv) return null;
    return inv.container ?? null;
  } catch (e) {
    // Some blocks don't expose inventory component reliably
    return null;
  }
}

function safeGetState(permutation, stateName) {
  try {
    return permutation.getState(stateName);
  } catch {
    return undefined;
  }
}

function facingDirNumberToName(n) {
  // Bedrock commonly maps:
  // 0=down,1=up,2=north,3=south,4=west,5=east
  switch (n) {
    case 0: return "down";
    case 1: return "up";
    case 2: return "north";
    case 3: return "south";
    case 4: return "west";
    case 5: return "east";
    default: return null;
  }
}

function oppositeDir(dir) {
  switch (dir) {
    case "north": return "south";
    case "south": return "north";
    case "east": return "west";
    case "west": return "east";
    case "up": return "down";
    case "down": return "up";
    default: return null;
  }
}

function dirToVec(dir) {
  switch (dir) {
    case "north": return { x: 0, y: 0, z: -1 };
    case "south": return { x: 0, y: 0, z: 1 };
    case "west": return { x: -1, y: 0, z: 0 };
    case "east": return { x: 1, y: 0, z: 0 };
    case "up": return { x: 0, y: 1, z: 0 };
    case "down": return { x: 0, y: -1, z: 0 };
    default: return { x: 0, y: 0, z: 0 };
  }
}
