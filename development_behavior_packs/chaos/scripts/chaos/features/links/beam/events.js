// scripts/chaos/features/links/beam/events.js
import {
  PRISM_IDS,
  CRYSTALLIZER_ID,
  BEAM_ID,
  EMIT_RETRY_TICKS,
  isPrismId,
} from "./config.js";

import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key, loadBeamsMap, saveBeamsMap } from "./storage.js";
import { bumpNetworkStamp } from "../shared/networkStamp.js";

import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  enqueueBeamsInLine,
  enqueueRelayForRescan,
  enqueueInputForRescan,
} from "./queue.js";

import { clearBeamsFromBreak, removeRecordedBeams } from "./rebuild.js";

const FACE_OFFSETS = {
  Up:    { x: 0, y: 1, z: 0 },
  Down:  { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 },
  South: { x: 0, y: 0, z: 1 },
  West:  { x: -1, y: 0, z: 0 },
  East:  { x: 1, y: 0, z: 0 },
};

const pendingEmit = new Set();
let globalInvalidateCachesFn = null;

function isNodeId(id) {
  return isPrismId(id) || id === CRYSTALLIZER_ID;
}

function scheduleEmitAt(world, system, dim, loc, attempt) {
  try {
    if (!dim || !loc) return;

    const k = key(dim.id, loc.x, loc.y, loc.z);

    if ((attempt | 0) === 0) {
      if (pendingEmit.has(k)) return;
      pendingEmit.add(k);
    }

    const placed = dim.getBlock(loc);

    // Prism placed → register immediately
    if (placed && isPrismId(placed.typeId)) {
      pendingEmit.delete(k);
      handlePrismPlaced(world, placed, globalInvalidateCachesFn);
      return;
    }

    const nextAttempt = (attempt | 0) + 1;
    if (nextAttempt < EMIT_RETRY_TICKS) {
      system.runTimeout(
        () => scheduleEmitAt(world, system, dim, loc, nextAttempt),
        1
      );
    } else {
      pendingEmit.delete(k);
    }
  } catch {
    // ignore
  }
}

function handleBlockChanged(world, dim, loc, prevId, nextId, invalidateCachesFn) {
  if (!dim || !loc) return;

  const fn = invalidateCachesFn || globalInvalidateCachesFn;
  if (typeof fn === "function") {
    try {
      fn(key(dim.id, loc.x, loc.y, loc.z));
    } catch {}
  }

  bumpNetworkStamp();

  enqueueAdjacentBeams(dim, loc);

  const beamTouched = prevId === BEAM_ID || nextId === BEAM_ID;
  if (beamTouched) enqueueAdjacentPrisms(dim, loc);

  const prevIsNode = isNodeId(prevId);
  const nextIsNode = isNodeId(nextId);

  // Node removed or replaced
  if (prevIsNode && !nextIsNode) {
    const prismKey = key(dim.id, loc.x, loc.y, loc.z);
    const map = loadBeamsMap(world);
    const entry = map[prismKey];

    if (entry) {
      removeRecordedBeams(world, entry);
      delete map[prismKey];
      saveBeamsMap(world, map);
    }

    enqueueBeamsInLine(dim, loc);
    clearBeamsFromBreak(world, dim, loc);
  }

  // Node added or changed
  if (nextIsNode) {
    enqueueRelayForRescan(key(dim.id, loc.x, loc.y, loc.z));
    enqueueAdjacentPrisms(dim, loc);
  }

  // Any solid change potentially breaks beams
  if (prevId !== nextId) {
    enqueueBeamsInLine(dim, loc);
    if (!nextIsNode) {
      clearBeamsFromBreak(world, dim, loc);
    }
  }
}

function handlePrismPlaced(world, block, invalidateCachesFn) {
  try {
    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return;

    if (!isPrismId(block.typeId)) return;

    const prismKey = key(dim.id, loc.x, loc.y, loc.z);

    const map = loadBeamsMap(world);
    map[prismKey] = { dimId: dim.id, x: loc.x, y: loc.y, z: loc.z, beams: [], kind: "prism" };
    saveBeamsMap(world, map);

    enqueueInputForRescan(prismKey);
    enqueueRelayForRescan(prismKey);
    enqueueAdjacentPrisms(dim, loc);

    handleBlockChanged(world, dim, loc, null, block.typeId, invalidateCachesFn);
  } catch {
    // ignore
  }
}

export function setCacheInvalidationFn(fn) {
  globalInvalidateCachesFn = fn;
}

export function registerBeamEvents(world, system, invalidateCachesFn = null) {
  globalInvalidateCachesFn = invalidateCachesFn;

  const onPlace = (b) => {
    scheduleEmitAt(world, system, b.dimension, b.location, 0);
    handleBlockChanged(world, b.dimension, b.location, null, b.typeId, invalidateCachesFn);
  };

  world.afterEvents.playerPlaceBlock.subscribe(ev => ev?.block && onPlace(ev.block));
  world.afterEvents.entityPlaceBlock?.subscribe(ev => ev?.block && onPlace(ev.block));
  world.afterEvents.blockPlace?.subscribe(ev => ev?.block && onPlace(ev.block));

  world.afterEvents.itemUseOn.subscribe(ev => {
    try {
      if (!PRISM_IDS.includes(ev?.itemStack?.typeId)) return;
      const off = FACE_OFFSETS[ev.blockFace];
      if (!off) return;

      const b = ev.block;
      scheduleEmitAt(
        world,
        system,
        b.dimension,
        { x: b.location.x + off.x, y: b.location.y + off.y, z: b.location.z + off.z },
        0
      );
    } catch {}
  });

  world.afterEvents.playerBreakBlock.subscribe(ev => {
    try {
      const brokenId = ev.brokenBlockPermutation?.type?.id;
      const dim = ev.block?.dimension;
      const loc = ev.block?.location;
      if (!dim || !loc) return;

      if (isPrismId(brokenId)) {
        const prismKey = key(dim.id, loc.x, loc.y, loc.z);
        const map = loadBeamsMap(world);
        if (map[prismKey]) {
          delete map[prismKey];
          saveBeamsMap(world, map);
        }
      }

      handleBlockChanged(world, dim, loc, brokenId, "minecraft:air", invalidateCachesFn);
    } catch {}
  });
}
