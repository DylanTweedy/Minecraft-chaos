import { world } from "@minecraft/server";
import { startBeamGrow } from "./beamMover.js";

const WAND_ID = "chaos:wand";

const DEFAULT_MAX_BLOCKS = 16;
const DEFAULT_SPEED_BLOCKS_PER_TICK = 1;
const DEFAULT_FADE_TICKS = 0;
const RAY_MAX_DISTANCE = 64;

// Toggle this to true for 1 session to confirm normals in chat
const DEBUG_FACE = false;

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function mul(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }

function blockCenter(loc) {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function faceEmitPosition(blockLoc, normal) {
  // center of face = block center + normal*0.5
  const faceCenter = add(blockCenter(blockLoc), mul(normal, 0.5));
  // epsilon nudge outward
  return add(faceCenter, mul(normal, 0.01));
}

function quantizeToAxis(dir) {
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  if (ay >= ax && ay >= az) return { x: 0, y: dir.y >= 0 ? 1 : -1, z: 0 };
  if (ax >= ay && ax >= az) return { x: dir.x >= 0 ? 1 : -1, y: 0, z: 0 };
  return { x: 0, y: 0, z: dir.z >= 0 ? 1 : -1 };
}

// Convert Direction-like values from itemUseOn into a normal.
// In many builds ev.blockFace is already {x,y,z}. If not, handle common enums/strings.
function blockFaceToNormal(face) {
  if (!face) return null;

  // Newer builds: already a vector
  if (typeof face.x === "number") return { x: face.x, y: face.y, z: face.z };

  // Sometimes numeric: 0..5 (ordering can vary by implementation)
  // We'll handle the most common mapping, but itemUseOn usually isn't numeric on modern builds.
  if (typeof face === "number") {
    switch (face | 0) {
      case 0: return { x: 0, y: -1, z: 0 };
      case 1: return { x: 0, y: 1, z: 0 };
      case 2: return { x: 0, y: 0, z: -1 };
      case 3: return { x: 0, y: 0, z: 1 };
      case 4: return { x: -1, y: 0, z: 0 };
      case 5: return { x: 1, y: 0, z: 0 };
      default: return null;
    }
  }

  const s = String(face).toLowerCase();
  if (s.includes("up") || s.includes("top")) return { x: 0, y: 1, z: 0 };
  if (s.includes("down") || s.includes("bottom")) return { x: 0, y: -1, z: 0 };
  if (s.includes("north")) return { x: 0, y: 0, z: -1 };
  if (s.includes("south")) return { x: 0, y: 0, z: 1 };
  if (s.includes("west")) return { x: -1, y: 0, z: 0 };
  if (s.includes("east")) return { x: 1, y: 0, z: 0 };

  return null;
}

function spawnBeamFromBlockFace(player, block, normal) {
  const start = faceEmitPosition(block.location, normal);

  if (DEBUG_FACE) {
    player.sendMessage(
      `face normal: (${normal.x},${normal.y},${normal.z}) @ ${block.typeId} ${block.location.x},${block.location.y},${block.location.z}`
    );
  }

  startBeamGrow(player.dimension, {
    start,
    dir: normal,
    maxBlocks: DEFAULT_MAX_BLOCKS,
    speedBlocksPerTick: DEFAULT_SPEED_BLOCKS_PER_TICK,
    fadeTicks: DEFAULT_FADE_TICKS,
    collide: false,
  });
}

// --- Primary path: itemUseOn (best, because it tells us which face was clicked) ---
const useOnSignal = world.beforeEvents?.itemUseOn ?? world.afterEvents?.itemUseOn;

if (useOnSignal?.subscribe) {
  useOnSignal.subscribe((ev) => {
    const player = ev.source;
    const item = ev.itemStack;
    if (!player || player.typeId !== "minecraft:player") return;
    if (!item || item.typeId !== WAND_ID) return;

    const block = ev.block;
    if (!block) return;

    const normal = blockFaceToNormal(ev.blockFace);
    if (!normal) return;

    spawnBeamFromBlockFace(player, block, normal);
  });
} else {
  // --- Fallback: raycast (works, but face can be ambiguous depending on API fields) ---
  world.afterEvents.itemUse.subscribe((ev) => {
    const player = ev.source;
    const item = ev.itemStack;
    if (!player || player.typeId !== "minecraft:player") return;
    if (!item || item.typeId !== WAND_ID) return;

    const hit = player.getBlockFromViewDirection?.({
      maxDistance: RAY_MAX_DISTANCE,
      includeLiquidBlocks: false,
      includePassableBlocks: false,
    });

    const block = hit?.block;
    if (!block) return;

    // If we can’t reliably get face, we fall back to axis view direction.
    const normal = quantizeToAxis(player.getViewDirection());
    spawnBeamFromBlockFace(player, block, normal);
  });
}
