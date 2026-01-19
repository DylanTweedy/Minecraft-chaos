// scripts/chaos/features/logistics/pathfinding/pathfinder.js
import { DEFAULTS, isPrismBlock, isEndpointId } from "../config.js";
import { mergeCfg } from "../utils.js";
import { parseKey } from "../keys.js";
import { getAllAdjacentInventories } from "../util/inventoryAdapter.js";

export function createTransferPathfinder(deps, opts) {
  const world = deps.world;
  const linkGraph = deps.linkGraph;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);
  const cache = new Map();
  // Cache for prism inventory checks during pathfinding (avoid expensive getAllAdjacentInventories calls)
  const prismInventoryCheckCache = new Map(); // prismKey -> { hasInventories: boolean, tick: number }
  const PRISM_INVENTORY_CHECK_CACHE_TTL = 10; // Cache for 10 ticks
  const stats = {
    searches: 0,
    visitedTotal: 0,
    visitedMax: 0,
    outputsTotal: 0,
    outputsMax: 0,
  };

  function invalidatePrism(prismKey) {
    cache.delete(prismKey);
    // Also invalidate inventory check cache for this prism
    prismInventoryCheckCache.delete(prismKey);
  }
  
  // Clean up old cache entries periodically
  function cleanupInventoryCheckCache(nowTick) {
    // Only cleanup if cache is getting large
    if (prismInventoryCheckCache.size > 100) {
      for (const [key, value] of prismInventoryCheckCache.entries()) {
        if ((nowTick - value.tick) > PRISM_INVENTORY_CHECK_CACHE_TTL * 2) {
          prismInventoryCheckCache.delete(key);
        }
      }
    }
  }

  // Find paths from a prism to other prisms (bidirectional - can push or pull)
  function findPathsForPrism(prismKey, nowTick, filterForPull = null) {
    const stamp = (typeof getNetworkStamp === "function") ? getNetworkStamp() : null;
    const cached = cache.get(prismKey);
    if (cached) {
      const ttl = (stamp == null || stamp !== cached.stamp)
        ? cfg.cacheTicks
        : Math.max(cfg.cacheTicks, cfg.cacheTicksWithStamp);
      const okTick = (nowTick - cached.tick) <= ttl;
      const okStamp = (stamp == null || stamp === cached.stamp);
      // If filter changed, invalidate cache
      const filterMatch = (filterForPull === null) === (cached.filterForPull === null);
      if (okTick && okStamp && filterMatch) return cached.outputs;
    }

    const parsed = parseKey(prismKey);
    if (!parsed) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
      return null;
    }

    const dim = world.getDimension(parsed.dimId);
    if (!dim) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
      return null;
    }

    const startBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!startBlock || !isPrismBlock(startBlock)) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
      return null;
    }

    // Optimization #2: Block lookup cache for this search (avoids repeated dim.getBlock calls)
    const blockCache = new Map(); // posKey -> block | null (null means already checked, block doesn't exist)
    
    // Helper function to get cached block
    function getBlockCached(x, y, z) {
      const posKey = `${x},${y},${z}`;
      if (blockCache.has(posKey)) {
        return blockCache.get(posKey);
      }
      const block = dim.getBlock({ x, y, z });
      blockCache.set(posKey, block || null); // Cache null explicitly if block doesn't exist
      return block;
    }

    const visited = new Set();
    const parent = new Map();
    let visitedCount = 0;
    const queue = [];
    let qIndex = 0;
    const startPos = { x: parsed.x, y: parsed.y, z: parsed.z };
    queue.push({
      nodeKey: prismKey,
      nodePos: startPos,
      nodeType: "prism",
    });
    visited.add(prismKey);
    visitedCount++;

    // Note: We don't do early termination anymore - BFS finds closer nodes first,
    // and early termination would prevent finding distant nodes. The weighted random
    // selection already biases toward shorter paths, so finding distant options is still valuable.
    // We rely on maxVisitedPerSearch to limit exploration instead.
    const outputs = [];
    
    // Minimum nodes to explore before considering early termination (ensures we find distant nodes)
    const MIN_EXPLORATION_NODES = 50; // Must explore at least this many nodes before early termination
    const maxOutputs = cfg.maxOutputOptions || 6;
    const earlyTerminationLimit = Math.max(15, maxOutputs * 2); // Much higher limit, only for very large networks
    
    while (qIndex < queue.length) {
      if (visitedCount >= cfg.maxVisitedPerSearch) break;
      const cur = queue[qIndex++];
      if (!cur) continue;
      if (!linkGraph || typeof linkGraph.getNeighbors !== "function") {
        cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
        return null;
      }

      const neighbors = linkGraph.getNeighbors(cur.nodeKey, { includePending: false });
      for (const edge of neighbors) {
        const nextKey = edge.key;
        if (visited.has(nextKey)) continue;
        const parsedNext = parseKey(nextKey);
        if (!parsedNext) continue;

        const targetBlock = getBlockCached(parsedNext.x, parsedNext.y, parsedNext.z);
        const isPrism = isPrismBlock(targetBlock);
        const isEndpoint = targetBlock && isEndpointId(targetBlock.typeId);

        let isValidOutput = true;
        if (isPrism) {
          try {
            const cached = prismInventoryCheckCache.get(nextKey);
            if (cached && (nowTick - cached.tick) <= PRISM_INVENTORY_CHECK_CACHE_TTL) {
              isValidOutput = cached.hasInventories;
            } else {
              const inventories = getAllAdjacentInventories(targetBlock, dim);
              isValidOutput = inventories && inventories.length > 0;
              prismInventoryCheckCache.set(nextKey, {
                hasInventories: isValidOutput,
                tick: nowTick,
              });
            }
          } catch (e) {
            isValidOutput = false;
          }
        }

        if (!parent.has(nextKey)) {
          parent.set(nextKey, { prevKey: cur.nodeKey, edgeId: edge.edgeId, key: nextKey });
        }

        if (isValidOutput && (isPrism || isEndpoint)) {
          const path = linkGraph.buildPathFromParents(prismKey, nextKey, parent);
          if (path) {
            outputs.push({
              dimId: parsed.dimId,
              outputKey: nextKey,
              outputPos: { x: parsedNext.x, y: parsedNext.y, z: parsedNext.z },
              path,
              outputType: isEndpoint ? "crystal" : "prism",
            });
          }
          if (visitedCount >= MIN_EXPLORATION_NODES && outputs.length >= earlyTerminationLimit) {
            visitedCount = cfg.maxVisitedPerSearch;
            break;
          }
        }

        visited.add(nextKey);
        visitedCount++;
        queue.push({ nodeKey: nextKey, nodePos: { x: parsedNext.x, y: parsedNext.y, z: parsedNext.z } });
        if (visitedCount >= cfg.maxVisitedPerSearch) break;
      }
      // Only break outer loop if we've explored enough AND found many outputs
      if (visitedCount >= MIN_EXPLORATION_NODES && outputs.length >= earlyTerminationLimit) break;
      // Continue searching until we've explored the network or hit visit limit
    }

    stats.searches++;
    stats.visitedTotal += visitedCount;
    stats.visitedMax = Math.max(stats.visitedMax, visitedCount);
    stats.outputsTotal += outputs.length;
    stats.outputsMax = Math.max(stats.outputsMax, outputs.length);

    // Cleanup inventory check cache periodically
    if (stats.searches % 50 === 0) {
      cleanupInventoryCheckCache(nowTick);
    }

    if (outputs.length > 0) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs, filterForPull });
      return outputs;
    }

    cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
    return null;
  }

  function findPathForInput(inputKey, nowTick) {
    return findPathsForPrism(inputKey, nowTick, null);
  }

  function invalidateInput(inputKey) {
    return invalidatePrism(inputKey);
  }

  function getAndResetStats() {
    const snapshot = {
      searches: stats.searches,
      visitedTotal: stats.visitedTotal,
      visitedMax: stats.visitedMax,
      outputsTotal: stats.outputsTotal,
      outputsMax: stats.outputsMax,
    };
    stats.searches = 0;
    stats.visitedTotal = 0;
    stats.visitedMax = 0;
    stats.outputsTotal = 0;
    stats.outputsMax = 0;
    return snapshot;
  }

  return { 
    findPathsForPrism, 
    findPathForInput,
    invalidatePrism,
    invalidateInput,
    getAndResetStats 
  };
}


