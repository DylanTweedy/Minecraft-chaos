// scripts/chaos/features/links/transfer/pathfinder.js
import { DEFAULTS, PRISM_ID } from "./config.js";
import { mergeCfg } from "./utils.js";
import { key, parseKey } from "./keys.js";
import { makeDirs, scanEdgeFromNode } from "./pathfinding/graph.js";

export function createTransferPathfinder(deps, opts) {
  const world = deps.world;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);
  const cache = new Map();
  const edgeCache = new Map();
  let edgeCacheStamp = null;
  const stats = {
    searches: 0,
    visitedTotal: 0,
    visitedMax: 0,
    outputsTotal: 0,
    outputsMax: 0,
  };

  function invalidatePrism(prismKey) {
    cache.delete(prismKey);
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
    if (!startBlock || startBlock.typeId !== PRISM_ID) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
      return null;
    }

    const visited = new Set();
    let visitedCount = 0;
    const queue = [];
    let qIndex = 0;
    queue.push({
      nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
      nodeType: "prism",
      path: [],
    });
    visited.add(key(parsed.dimId, parsed.x, parsed.y, parsed.z));
    visitedCount++;

    const outputs = [];
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
          outputs.push({
            dimId: parsed.dimId,
            outputKey: nextKey,
            outputPos: edge.nodePos,
            path: nextPath,
            outputType: edge.nodeType,
          });
          if (outputs.length >= cfg.maxOutputOptions) {
            visited.add(nextKey);
            visitedCount++;
            queue.push({
              nodePos: edge.nodePos,
              nodeType: edge.nodeType,
              path: nextPath,
            });
            break;
          }
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
      if (outputs.length >= cfg.maxOutputOptions) break;
    }

    stats.searches++;
    stats.visitedTotal += visitedCount;
    stats.visitedMax = Math.max(stats.visitedMax, visitedCount);
    stats.outputsTotal += outputs.length;
    stats.outputsMax = Math.max(stats.outputsMax, outputs.length);

    if (outputs.length > 0) {
      cache.set(prismKey, { tick: nowTick, stamp, outputs, filterForPull });
      return outputs;
    }

    cache.set(prismKey, { tick: nowTick, stamp, outputs: null, filterForPull });
    return null;
  }

  // Legacy compatibility
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
    findPathForInput, // Legacy compatibility
    invalidatePrism,
    invalidateInput, // Legacy compatibility
    getAndResetStats 
  };
}
