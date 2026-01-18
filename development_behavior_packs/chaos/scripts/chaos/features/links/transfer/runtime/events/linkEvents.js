// scripts/chaos/features/links/transfer/runtime/events/linkEvents.js
import { BEAM_ID, isPrismId, isEndpointId, isPrismBlock } from "../../config.js";
import { key, prismKeyFromBlock } from "../../keys.js";

const FACE_DIRS = [
  { dx: 1, dy: 0, dz: 0 },
  { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy: 0, dz: 1 },
  { dx: 0, dy: 0, dz: -1 },
  { dx: 0, dy: 1, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
];

function isNodeBlock(block) {
  if (!block) return false;
  if (isPrismBlock(block)) return true;
  return isEndpointId(block.typeId);
}

export function subscribeLinkEvents(deps) {
  const world = deps?.world;
  const system = deps?.system;
  const prismRegistry = deps?.prismRegistry;
  const linkGraph = deps?.linkGraph;
  const debugLog = deps?.debugLog || (() => {});

  if (!world?.afterEvents) return { drainBeamBreaks: () => [] };

  const beamBreakQueue = [];
  const beamBreakQueued = new Set();

  function enqueueBeamBreak(dimId, loc) {
    const k = key(dimId, loc.x, loc.y, loc.z);
    if (beamBreakQueued.has(k)) return;
    beamBreakQueued.add(k);
    beamBreakQueue.push({ dimId, x: loc.x, y: loc.y, z: loc.z });
  }

  function drainBeamBreaks(maxCount) {
    const out = [];
    const take = Math.max(0, Number(maxCount) | 0);
    while (out.length < take && beamBreakQueue.length > 0) {
      const item = beamBreakQueue.shift();
      beamBreakQueued.delete(key(item.dimId, item.x, item.y, item.z));
      out.push(item);
    }
    return out;
  }

  function markAdjacentNodesDirty(dim, loc) {
    if (!linkGraph || typeof linkGraph.markNodeDirty !== "function") return;
    for (const d of FACE_DIRS) {
      const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
      if (isNodeBlock(b)) {
        linkGraph.markNodeDirty(key(dim.id, b.location.x, b.location.y, b.location.z));
      }
    }
  }

  function handleNodePlaced(block) {
    if (!block) return;
    const loc = block.location;
    const dim = block.dimension;
    const prismKey = prismKeyFromBlock(block);
    if (isPrismId(block.typeId)) {
      prismRegistry?.addPrism?.(prismKey, "linkEvents:playerPlace");
      linkGraph?.markNodeDirty?.(prismKey);
      markAdjacentNodesDirty(dim, loc);
      return;
    }
    if (isEndpointId(block.typeId)) {
      linkGraph?.markNodeDirty?.(prismKey);
      markAdjacentNodesDirty(dim, loc);
    }
  }

  function handleNodeBroken(dim, loc, brokenId) {
    const prismKey = key(dim.id, loc.x, loc.y, loc.z);
    if (isPrismId(brokenId)) {
      prismRegistry?.removePrism?.(prismKey);
      linkGraph?.markNodeDirty?.(prismKey);
      markAdjacentNodesDirty(dim, loc);
      return;
    }
    if (isEndpointId(brokenId)) {
      linkGraph?.markNodeDirty?.(prismKey);
      markAdjacentNodesDirty(dim, loc);
    }
  }

  function handleBlockChanged(dim, loc, prevId, nextId) {
    if (!dim || !loc) return;
    if (prevId === BEAM_ID) enqueueBeamBreak(dim.id, loc);
    if (nextId === BEAM_ID) enqueueBeamBreak(dim.id, loc);
  }

  function safeSubscribe(signal, handler) {
    try {
      if (!signal || typeof signal.subscribe !== "function") return false;
      signal.subscribe(handler);
      return true;
    } catch (e) {
      return false;
    }
  }

  safeSubscribe(world.afterEvents.playerPlaceBlock, (ev) => {
    const b = ev?.block;
    if (!b) return;
    handleNodePlaced(b);
    handleBlockChanged(b.dimension, b.location, null, b.typeId);
  });

  safeSubscribe(world.afterEvents.entityPlaceBlock, (ev) => {
    const b = ev?.block;
    if (!b) return;
    handleNodePlaced(b);
    handleBlockChanged(b.dimension, b.location, null, b.typeId);
  });

  safeSubscribe(world.afterEvents.blockPlace, (ev) => {
    const b = ev?.block;
    if (!b) return;
    handleNodePlaced(b);
    handleBlockChanged(b.dimension, b.location, null, b.typeId);
  });

  safeSubscribe(world.afterEvents.playerBreakBlock, (ev) => {
    const brokenId = ev?.brokenBlockPermutation?.type?.id;
    const dim = ev?.block?.dimension || ev?.dimension;
    const loc = ev?.block?.location;
    if (!dim || !loc) return;
    handleNodeBroken(dim, loc, brokenId);
    handleBlockChanged(dim, loc, brokenId, "minecraft:air");
  });

  debugLog("[LinkEvents] subscribed");

  return { drainBeamBreaks };
}
