// scripts/chaos/features/links/beam/events.js
import { CRYSTALLIZER_ID, BEAM_ID, isPassThrough, EMIT_RETRY_TICKS } from "./config.js";
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

    // Handle prism or crystallizer placement
    if (placed && (isPrismBlock(placed) || placed.typeId === CRYSTALLIZER_ID)) {
      pendingEmit.delete(k);
      handlePrismPlaced(world, placed);
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
  
  // Always enqueue adjacent prisms when blocks change - they need to rebuild beams
  enqueueAdjacentPrisms(dim, loc);

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
    const isRelay = (id, block = null) => {
      if (block && isPrismBlock(block)) return true;
      if (isPrismBlock({ typeId: id })) return true;
      return id === CRYSTALLIZER_ID;
    };
    if (!isRelay(selfId)) {
      clearBeamsFromBreak(world, dim, loc);
    }
  }

  // Only scan adjacent blocks - don't scan full beam length to reduce cascading updates
  // This prevents excessive rebuilds when blocks change
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  // Always enqueue adjacent prisms/crystallizers when blocks change - they need to rebuild beams
  for (const d of dirs) {
    const x = loc.x + d.dx;
    const y = loc.y + d.dy;
    const z = loc.z + d.dz;
    const b = dim.getBlock({ x, y, z });
    if (!b) continue;

    const id = b.typeId;
    // Enqueue adjacent prisms/crystallizers - they'll handle their own beam rebuilding
    if (isPrismBlock({ typeId: id }) || id === CRYSTALLIZER_ID) {
      enqueueRelayForRescan(key(dim.id, x, y, z));
    }
  }
}

function handlePrismPlaced(world, block) {
  // Register any tier prism block or crystallizer
  try {
    if (!block) return;

    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return;

    const placed = dim.getBlock(loc);
    if (!placed || (!isPrismBlock(placed) && placed.typeId !== CRYSTALLIZER_ID)) return;

    const dimId = placed.dimension.id;
    // Floor coordinates to ensure integer block positions
    const x = Math.floor(placed.location.x);
    const y = Math.floor(placed.location.y);
    const z = Math.floor(placed.location.z);
    const prismKey = key(dimId, x, y, z);

    const map = loadBeamsMap(world);
    // Store connections (prism/crystallizer keys this block connects to), not individual beam block locations
    const isCrystallizer = placed.typeId === CRYSTALLIZER_ID;
    const entry = { dimId, x, y, z, connections: [], kind: isCrystallizer ? "crystallizer" : "prism" };
    map[prismKey] = entry;
    saveBeamsMap(world, map);

    // Debug: log prism registration and verify it can be found
    try {
      const players = world.getAllPlayers();
      // Verify the block exists at the registered location
      const verifyBlock = dim.getBlock({ x, y, z });
      const verifyMsg = verifyBlock && isPrismBlock(verifyBlock)
        ? `[Beam] Prism registered: ${prismKey} at ${x},${y},${z} ✓`
        : `[Beam] Prism registered: ${prismKey} at ${x},${y},${z} ⚠ (verify failed: ${verifyBlock?.typeId || "null"})`;
      for (const player of players) {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(verifyMsg);
        }
      }
    } catch {}

    // Enqueue prism for initial beam building (uses pendingInputs queue)
    enqueueInputForRescan(prismKey);
    // Also enqueue as relay so adjacent prisms rebuild beams to this new prism
    enqueueRelayForRescan(prismKey);
    // Enqueue adjacent prisms to rebuild their beams
    enqueueAdjacentPrisms(dim, loc);
    handleBlockChanged(world, dim, loc);
  } catch (err) {
    // Log error for debugging
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(`[Beam] Error registering prism: ${err?.message || String(err)}`);
        }
      }
    } catch {}
  }
}

function handleInputPlaced(world, block) {
  return handlePrismPlaced(world, block);
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
        // Handle prism or crystallizer placement via item use
        if (!isPrismBlock({ typeId: itemId }) && itemId !== CRYSTALLIZER_ID) return;

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

      // Clean up prism or crystallizer entry on break
      if (isPrismBlock({ typeId: brokenId }) || brokenId === CRYSTALLIZER_ID) {
        const prismKey = key(dim.id, loc.x, loc.y, loc.z);
        const map = loadBeamsMap(world);
        if (map[prismKey]) {
          delete map[prismKey];
          saveBeamsMap(world, map);
        }
      }

      handleBlockChanged(world, dim, loc, brokenId, "minecraft:air");
    } catch {
      // ignore
    }
  });
}
