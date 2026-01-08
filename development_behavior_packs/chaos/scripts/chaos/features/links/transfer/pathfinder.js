// scripts/chaos/features/links/transfer/pathfinder.js
import { DEFAULTS, isPrismBlock } from "./config.js";
import { mergeCfg } from "./utils.js";
import { key, parseKey } from "./keys.js";
import { makeDirs, scanEdgeFromNode } from "./graph.js";
import { getAllAdjacentInventories } from "./inventory.js";

export function createTransferPathfinder(deps, opts) {
  const world = deps.world;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);
  const cache = new Map();
  const edgeCache = new Map();
  let edgeCacheStamp = null;
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
    let visitedCount = 0;
    const queue = [];
    let qIndex = 0;
    const startPos = { x: parsed.x, y: parsed.y, z: parsed.z };
    queue.push({
      nodePos: startPos,
      nodeType: "prism",
      path: [startPos], // Include starting position in path
    });
    visited.add(key(parsed.dimId, parsed.x, parsed.y, parsed.z));
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
      if (stamp !== edgeCacheStamp) {
        edgeCache.clear();
        edgeCacheStamp = stamp;
      }

      const curKey = key(parsed.dimId, cur.nodePos.x, cur.nodePos.y, cur.nodePos.z);
      const edgeKey = `${curKey}|${cur.nodeType}`;
      let edges = edgeCache.get(edgeKey);
      if (!edges) {
        edges = [];
        const dirs = makeDirs();
        for (const d of dirs) {
          const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
          if (edge) edges.push(edge);
        }
        edgeCache.set(edgeKey, edges);
      }

      for (const edge of edges) {
        const nextKey = key(parsed.dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
        if (visited.has(nextKey)) continue;

        const nextPath = cur.path.concat(edge.path, [edge.nodePos]);

        // Target prisms (or crystallizers) can receive items
        if (edge.nodeType === "prism" || edge.nodeType === "crystal") {
          // For prisms, check if they have inventories before adding as output
          // Crystallizers can always accept items (no check needed)
          let isValidOutput = true;
          if (edge.nodeType === "prism") {
            try {
              // Use cached inventory check to avoid expensive getAllAdjacentInventories calls
              const cached = prismInventoryCheckCache.get(nextKey);
              if (cached && (nowTick - cached.tick) <= PRISM_INVENTORY_CHECK_CACHE_TTL) {
                isValidOutput = cached.hasInventories;
              } else {
                // Not cached or expired - check and cache
                // Optimization #2: Use block cache to avoid repeated dim.getBlock calls
                const targetBlock = getBlockCached(edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
                if (targetBlock && isPrismBlock(targetBlock)) {
                  const inventories = getAllAdjacentInventories(targetBlock, dim);
                  isValidOutput = inventories && inventories.length > 0;
                  // Cache the result
                  prismInventoryCheckCache.set(nextKey, {
                    hasInventories: isValidOutput,
                    tick: nowTick,
                  });
                } else {
                  isValidOutput = false;
                  // Cache negative result too
                  prismInventoryCheckCache.set(nextKey, {
                    hasInventories: false,
                    tick: nowTick,
                  });
                }
              }
            } catch {
              isValidOutput = false;
            }
          }
          
          if (isValidOutput) {
            outputs.push({
              dimId: parsed.dimId,
              outputKey: nextKey,
              outputPos: edge.nodePos,
              path: nextPath,
              outputType: edge.nodeType,
            });
            // Only terminate early if we've explored enough nodes AND found many outputs
            // This ensures we find both close and distant nodes before stopping
            if (visitedCount >= MIN_EXPLORATION_NODES && outputs.length >= earlyTerminationLimit) {
              // Found many outputs after exploring enough - terminate search early
              visitedCount = cfg.maxVisitedPerSearch; // Force loop exit
              break;
            }
          }
          // If prism has no inventories, continue searching through it but don't add as output
        }

        visited.add(nextKey);
        visitedCount++;
        queue.push({
          nodePos: edge.nodePos,
          nodeType: edge.nodeType,
          path: nextPath,
        });
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
