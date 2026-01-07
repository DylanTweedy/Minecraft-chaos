// scripts/chaos/features/links/transfer/pathfinder.js
import { DEFAULTS, INPUT_ID } from "./config.js";
import { mergeCfg } from "./utils.js";
import { key, parseKey } from "./keys.js";
import { makeDirs, scanEdgeFromNode } from "./graph.js";

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

  function invalidateInput(inputKey) {
    cache.delete(inputKey);
  }

  function findPathForInput(inputKey, nowTick) {
    const stamp = (typeof getNetworkStamp === "function") ? getNetworkStamp() : null;
    const cached = cache.get(inputKey);
    if (cached) {
      const ttl = (stamp == null || stamp !== cached.stamp)
        ? cfg.cacheTicks
        : Math.max(cfg.cacheTicks, cfg.cacheTicksWithStamp);
      const okTick = (nowTick - cached.tick) <= ttl;
      const okStamp = (stamp == null || stamp === cached.stamp);
      if (okTick && okStamp) return cached.outputs;
    }

    const parsed = parseKey(inputKey);
    if (!parsed) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const dim = world.getDimension(parsed.dimId);
    if (!dim) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const startBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!startBlock || startBlock.typeId !== INPUT_ID) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const visited = new Set();
    let visitedCount = 0;
    const queue = [];
    let qIndex = 0;
    queue.push({
      nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
      nodeType: "input",
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

        if (edge.nodeType === "output" || edge.nodeType === "crystal") {
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
      cache.set(inputKey, { tick: nowTick, stamp, outputs });
      return outputs;
    }

    cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
    return null;
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

  return { findPathForInput, invalidateInput, getAndResetStats };
}
