// scripts/chaos/features/links/beam/events.js
import { PRISM_IDS, CRYSTALLIZER_ID, BEAM_ID, isPassThrough, EMIT_RETRY_TICKS } from "./config.js";
import { isPrismBlock } from "../transfer/config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key, loadBeamsMap, saveBeamsMap } from "./storage.js";
import { bumpNetworkStamp } from "../networkStamp.js";
import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  enqueueBeamsInLine,
  enqueueRelayForRescan,
  enqueueInputForRescan,
} from "./queue.js";
import { clearBeamsFromBreak, removeRecordedBeams } from "./rebuild.js";

const FACE_OFFSETS = {
  Up: { x: 0, y: 1, z: 0 },
  Down: { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 },
  South: { x: 0, y: 0, z: 1 },
  West: { x: -1, y: 0, z: 0 },
  East: { x: 1, y: 0, z: 0 },
};

const pendingEmit = new Set();
let globalInvalidateCachesFn = null;

function scheduleEmitAt(world, system, dim, loc, attempt) {
  try {
    if (!dim || !loc) return;

    const dimId = dim.id;
    const k = key(dimId, loc.x, loc.y, loc.z);

    if ((attempt | 0) === 0) {
      if (pendingEmit.has(k)) return;
      pendingEmit.add(k);
    }

    const placed = dim.getBlock(loc);

    // Handle prism placement
    if (placed && isPrismBlock(placed)) {
      pendingEmit.delete(k);
      handlePrismPlaced(world, placed, globalInvalidateCachesFn);
      return;
    }

    const a = (attempt | 0) + 1;
    if (a < EMIT_RETRY_TICKS) {
      system.runTimeout(() => scheduleEmitAt(world, system, dim, loc, a), 1);
    } else {
      pendingEmit.delete(k);
    }
  } catch {
    // ignore
  }
}

function handleBlockChanged(world, dim, loc, prevId, nextId, invalidateCachesFn = null) {
  if (!dim || !loc) return;

  // Invalidate caches for this block change if callback is provided
  // Check both parameter and global variable (parameter takes precedence for explicit passing)
  const fnToUse = invalidateCachesFn || globalInvalidateCachesFn;
  if (fnToUse && typeof fnToUse === "function") {
    try {
      const blockKey = key(dim.id, loc.x, loc.y, loc.z);
      fnToUse(blockKey);
    } catch {
      // Ignore errors in cache invalidation - don't break block change handling
    }
  }

  bumpNetworkStamp();
  enqueueAdjacentBeams(dim, loc);

  const self = dim.getBlock(loc);
  const selfId = nextId || self?.typeId;
  const beamChanged = (prevId === BEAM_ID || selfId === BEAM_ID);
  if (beamChanged) enqueueAdjacentPrisms(dim, loc);

  const isRelay = (id) => isPrismBlock({ typeId: id }) || id === CRYSTALLIZER_ID;
  if (isRelay(selfId) || isRelay(prevId)) {
    enqueueRelayForRescan(key(dim.id, loc.x, loc.y, loc.z));
  }
  if (isRelay(prevId)) {
    const map = loadBeamsMap(world);
    const prismKey = key(dim.id, loc.x, loc.y, loc.z);
    const entry = map[prismKey];
    if (entry) {
      removeRecordedBeams(world, entry);
      delete map[prismKey];
      saveBeamsMap(world, map);
    }
    enqueueBeamsInLine(dim, loc);
    clearBeamsFromBreak(world, dim, loc);
  }

  const nonPassThroughPrev = !!(prevId && !isPassThrough(prevId));
  const nonPassThroughNext = !!(selfId && !isPassThrough(selfId));
  if (nonPassThroughPrev || nonPassThroughNext) {
    enqueueBeamsInLine(dim, loc);
    const isRelay = (id) => isPrismBlock({ typeId: id }) || id === CRYSTALLIZER_ID;
    if (!isRelay(selfId)) {
      clearBeamsFromBreak(world, dim, loc);
    }
  }

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
      const isRelay = (id) => isPrismBlock({ typeId: id }) || id === CRYSTALLIZER_ID;
      // All prisms are treated as relays
      if (isPrismBlock(b)) {
        enqueueRelayForRescan(key(dim.id, x, y, z));
        break;
      }
      if (isRelay(id)) {
        enqueueRelayForRescan(key(dim.id, x, y, z));
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
  }
}

function handlePrismPlaced(world, block, invalidateCachesFn = null) {
  try {
    if (!block) return;

    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return;

    const placed = dim.getBlock(loc);
    if (!placed || !isPrismBlock(placed)) return;

    const dimId = placed.dimension.id;
    const { x, y, z } = placed.location;
    const prismKey = key(dimId, x, y, z);

    const map = loadBeamsMap(world);
    const entry = { dimId, x, y, z, beams: [], kind: "prism" };
    map[prismKey] = entry;
    saveBeamsMap(world, map);

    // Enqueue prism for initial beam building (uses pendingInputs queue)
    enqueueInputForRescan(prismKey);
    // Also enqueue as relay so adjacent prisms rebuild beams to this new prism
    enqueueRelayForRescan(prismKey);
    // Enqueue adjacent prisms to rebuild their beams
    enqueueAdjacentPrisms(dim, loc);
    handleBlockChanged(world, dim, loc, null, null, invalidateCachesFn);
  } catch {
    // ignore
  }
}

// Legacy function name for compatibility
function handleInputPlaced(world, block) {
  return handlePrismPlaced(world, block);
}

/**
 * Update the cache invalidation function (can be called later after transfer loop initializes)
 */
export function setCacheInvalidationFn(invalidateCachesFn) {
  globalInvalidateCachesFn = invalidateCachesFn;
}

export function registerBeamEvents(world, system, invalidateCachesFn = null) {
  // Store globally so scheduleEmitAt can access it
  globalInvalidateCachesFn = invalidateCachesFn;
  
  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const b = ev?.block;
      if (!b) return;
      scheduleEmitAt(world, system, b.dimension, b.location, 0);
      handleBlockChanged(world, b.dimension, b.location, null, b.typeId, invalidateCachesFn);
    } catch {
      // ignore
    }
  });

  try {
    world.afterEvents.entityPlaceBlock.subscribe((ev) => {
      try {
        const b = ev?.block;
        if (!b) return;
        scheduleEmitAt(world, system, b.dimension, b.location, 0);
        handleBlockChanged(world, b.dimension, b.location, null, b.typeId, invalidateCachesFn);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    world.afterEvents.blockPlace.subscribe((ev) => {
      try {
        const b = ev?.block;
        if (!b) return;
        scheduleEmitAt(world, system, b.dimension, b.location, 0);
        handleBlockChanged(world, b.dimension, b.location, null, b.typeId, invalidateCachesFn);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    world.afterEvents.itemUseOn.subscribe((ev) => {
      try {
        const itemId = ev?.itemStack?.typeId;
        // Handle prism placement via item use (any tier)
        if (!itemId || !PRISM_IDS.includes(itemId)) return;

        const clicked = ev?.block;
        const face = ev?.blockFace;
        if (!clicked || !face) return;

        const off = FACE_OFFSETS[face];
        if (!off) return;

        const loc = clicked.location;
        const target = { x: loc.x + off.x, y: loc.y + off.y, z: loc.z + off.z };
        scheduleEmitAt(world, system, clicked.dimension, target, 0);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev.brokenBlockPermutation?.type?.id;
      const dim = ev.block?.dimension;
      const loc = ev.block?.location;
      if (!dim || !loc) return;

      // Clean up prism entry on break (any tier)
      if (brokenId && PRISM_IDS.includes(brokenId)) {
        const prismKey = key(dim.id, loc.x, loc.y, loc.z);
        const map = loadBeamsMap(world);
        if (map[prismKey]) {
          delete map[prismKey];
          saveBeamsMap(world, map);
        }
      }

      handleBlockChanged(world, dim, loc, brokenId, "minecraft:air", invalidateCachesFn);
    } catch {
      // ignore
    }
  });
}
