// scripts/chaos/features/links/beam/events.js
import { INPUT_ID, OUTPUT_ID, PRISM_ID, CRYSTALLIZER_ID, BEAM_ID, isPassThrough, EMIT_RETRY_TICKS } from "./config.js";
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";
import { key, loadBeamsMap, saveBeamsMap } from "./storage.js";
import { bumpNetworkStamp } from "../networkStamp.js";
import {
  enqueueAdjacentBeams,
  enqueueAdjacentPrisms,
  enqueueBeamsInLine,
  enqueueInputForRescan,
  enqueueRelayForRescan,
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

    if (placed && placed.typeId === INPUT_ID) {
      pendingEmit.delete(k);
      handleInputPlaced(world, placed);
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

function handleBlockChanged(world, dim, loc, prevId, nextId) {
  if (!dim || !loc) return;

  bumpNetworkStamp();
  enqueueAdjacentBeams(dim, loc);

  const self = dim.getBlock(loc);
  const selfId = nextId || self?.typeId;
  const beamChanged = (prevId === BEAM_ID || selfId === BEAM_ID);
  if (beamChanged) enqueueAdjacentPrisms(dim, loc);

  if (selfId === PRISM_ID || prevId === PRISM_ID || selfId === CRYSTALLIZER_ID || prevId === CRYSTALLIZER_ID) {
    enqueueRelayForRescan(key(dim.id, loc.x, loc.y, loc.z));
  }
  if (prevId === PRISM_ID || prevId === CRYSTALLIZER_ID) {
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
    if (selfId !== OUTPUT_ID && selfId !== INPUT_ID && selfId !== PRISM_ID && selfId !== CRYSTALLIZER_ID) {
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
      if (id === INPUT_ID) {
        enqueueInputForRescan(key(dim.id, x, y, z));
        break;
      }
      if (id === PRISM_ID || id === CRYSTALLIZER_ID) {
        enqueueRelayForRescan(key(dim.id, x, y, z));
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
  }
}

function handleInputPlaced(world, block) {
  try {
    if (!block) return;

    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return;

    const placed = dim.getBlock(loc);
    if (!placed || placed.typeId !== INPUT_ID) return;

    const dimId = placed.dimension.id;
    const { x, y, z } = placed.location;
    const inputKey = key(dimId, x, y, z);

    const map = loadBeamsMap(world);
    const entry = { dimId, x, y, z, beams: [], kind: "input" };
    map[inputKey] = entry;
    saveBeamsMap(world, map);

    enqueueInputForRescan(inputKey);
    handleBlockChanged(world, dim, loc);
  } catch {
    // ignore
  }
}

export function registerBeamEvents(world, system) {
  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const b = ev?.block;
      if (!b) return;
      scheduleEmitAt(world, system, b.dimension, b.location, 0);
      handleBlockChanged(world, b.dimension, b.location, null, b.typeId);
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
        handleBlockChanged(world, b.dimension, b.location, null, b.typeId);
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
        handleBlockChanged(world, b.dimension, b.location, null, b.typeId);
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
        if (itemId !== INPUT_ID) return;

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

      if (brokenId === INPUT_ID) {
        const inputKey = key(dim.id, loc.x, loc.y, loc.z);
        const map = loadBeamsMap(world);
        if (map[inputKey]) {
          delete map[inputKey];
          saveBeamsMap(world, map);
        }
      }

      handleBlockChanged(world, dim, loc, brokenId, "minecraft:air");
    } catch {
      // ignore
    }
  });
}
