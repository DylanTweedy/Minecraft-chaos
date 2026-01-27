// scripts/chaos/features/logistics/runtime/events/linkEvents.js
import { BlockPermutation } from "@minecraft/server";
import { LENS_ID, isBeamId, isPrismId, isEndpointId, isPrismBlock, isGlassBlockId } from "../../config.js";
import { beamAxisMatchesDir } from "../../network/beams/axis.js";
import { key, prismKeyFromBlock } from "../../keys.js";
import { lensAllowsDir, lensFacingForAxis, getLensColorFromGlassId } from "../../util/lens.js";
import { emitTrace } from "../../../../core/insight/trace.js";

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

function isBeamOrNodeForDir(block, dx, dy, dz) {
  if (!block) return false;
  if (isBeamId(block.typeId)) return beamAxisMatchesDir(block, dx, dy, dz);
  if (block.typeId === LENS_ID) return lensAllowsDir(block, dx, dy, dz);
  return isNodeBlock(block);
}

function inferLensAxis(dim, loc) {
  if (!dim || !loc) return null;
  const axes = [
    { axis: "x", a: { dx: 1, dy: 0, dz: 0 }, b: { dx: -1, dy: 0, dz: 0 } },
    { axis: "y", a: { dx: 0, dy: 1, dz: 0 }, b: { dx: 0, dy: -1, dz: 0 } },
    { axis: "z", a: { dx: 0, dy: 0, dz: 1 }, b: { dx: 0, dy: 0, dz: -1 } },
  ];

  let best = null;
  let bestScore = 0;
  for (const entry of axes) {
    const ba = dim.getBlock({ x: loc.x + entry.a.dx, y: loc.y + entry.a.dy, z: loc.z + entry.a.dz });
    const bb = dim.getBlock({ x: loc.x + entry.b.dx, y: loc.y + entry.b.dy, z: loc.z + entry.b.dz });
    let score = 0;
    if (isBeamOrNodeForDir(ba, entry.a.dx, entry.a.dy, entry.a.dz)) score++;
    if (isBeamOrNodeForDir(bb, entry.b.dx, entry.b.dy, entry.b.dz)) score++;
    if (score > bestScore) {
      best = entry.axis;
      bestScore = score;
    }
  }

  if (bestScore >= 1) return best;
  return null;
}

function tryConvertGlassToLens(block) {
  try {
    if (!block || !isGlassBlockId(block.typeId)) return false;
    const axis = inferLensAxis(block.dimension, block.location);
    if (!axis) return false;
    const facing = lensFacingForAxis(axis);
    const color = getLensColorFromGlassId(block.typeId);
    const perm = BlockPermutation.resolve(LENS_ID, {
      "minecraft:facing_direction": facing,
      "chaos:lens_color": color,
    });
    block.setPermutation(perm);
    emitTrace(null, "lens", {
      text: `[Lens] Created ${color} lens at ${block.location.x},${block.location.y},${block.location.z}`,
      category: "lens",
      dedupeKey: `lens_create_${block.dimension.id}_${block.location.x}_${block.location.y}_${block.location.z}`,
    });
    return true;
  } catch (e) {
    return false;
  }
}

function resolvePatchedBlock(block) {
  if (!block) return null;
  try {
    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return block;
    const fresh = dim.getBlock({ x: loc.x, y: loc.y, z: loc.z });
    return fresh || block;
  } catch {
    return block;
  }
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

  function processPlacement(block) {
    if (!block) return;
    const converted = tryConvertGlassToLens(block);
    const finalBlock = converted ? resolvePatchedBlock(block) : block;
    if (!finalBlock) return;
    if (converted || finalBlock.typeId === LENS_ID) {
      markAdjacentNodesDirty(finalBlock.dimension, finalBlock.location);
    }
    handleNodePlaced(finalBlock);
    handleBlockChanged(
      finalBlock.dimension,
      finalBlock.location,
      null,
      finalBlock.typeId
    );
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
    const isBeamLike = (id) => isBeamId(id) || id === LENS_ID;
    if (prevId && isBeamLike(prevId)) enqueueBeamBreak(dim.id, loc);
    if (nextId && isBeamLike(nextId)) enqueueBeamBreak(dim.id, loc);
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
    processPlacement(ev?.block);
  });

  safeSubscribe(world.afterEvents.entityPlaceBlock, (ev) => {
    processPlacement(ev?.block);
  });

  safeSubscribe(world.afterEvents.blockPlace, (ev) => {
    processPlacement(ev?.block);
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


