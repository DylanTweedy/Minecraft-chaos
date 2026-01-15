// scripts/chaos/features/links/transfer/runtime/hybrid/routing.js

export function pickDriftNeighbor(linkGraph, curKey, prevKey) {
  if (!linkGraph || !curKey) return null;
  const neighbors = linkGraph.getNeighbors ? linkGraph.getNeighbors(curKey) : [];
  if (!Array.isArray(neighbors) || neighbors.length === 0) return null;
  const options = neighbors.filter((opt) => opt && opt.key && opt.key !== prevKey);
  const pool = options.length > 0 ? options : neighbors;
  if (pool.length === 0) return null;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  return choice?.key || null;
}

export function findRouteBfs(linkGraph, sourceKey, destKey, scheduler = null) {
  if (!linkGraph || !sourceKey || !destKey) return null;
  const queue = [{ key: sourceKey, prev: null }];
  const visited = new Set([sourceKey]);
  const parent = new Map();

  while (queue.length > 0) {
    const current = queue.shift();
    if (scheduler && !scheduler.canPathfind()) break;
    if (scheduler) scheduler.usePathfind();
    if (current.key === destKey) break;
    const neighbors = linkGraph.getNeighbors ? linkGraph.getNeighbors(current.key) : [];
    for (const neighbor of neighbors || []) {
      const nextKey = neighbor?.key;
      if (!nextKey || visited.has(nextKey)) continue;
      visited.add(nextKey);
      parent.set(nextKey, current.key);
      queue.push({ key: nextKey, prev: current.key });
    }
  }

  if (!visited.has(destKey)) return null;

  const path = [];
  let cursor = destKey;
  while (cursor) {
    path.unshift(cursor);
    cursor = parent.get(cursor);
  }

  return { prismKeys: path, edgeEpochs: [] };
}
