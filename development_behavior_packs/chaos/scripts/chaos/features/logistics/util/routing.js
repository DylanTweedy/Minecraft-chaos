// scripts/chaos/features/logistics/util/routing.js

export function findPathBetweenKeys(linkGraph, startKey, endKey, maxSteps = 120) {
  if (!linkGraph || !startKey || !endKey) return null;
  if (startKey === endKey) return [startKey];

  const queue = [startKey];
  const visited = new Set([startKey]);
  const parent = new Map();

  while (queue.length > 0 && visited.size <= maxSteps) {
    const current = queue.shift();
    const neighbors = linkGraph.getNeighbors(current) || [];
    for (const neighbor of neighbors) {
      const key = neighbor?.key;
      if (!key || visited.has(key)) continue;
      visited.add(key);
      parent.set(key, current);
      if (key === endKey) {
        const path = [endKey];
        let cur = endKey;
        while (parent.has(cur)) {
          cur = parent.get(cur);
          path.unshift(cur);
          if (cur === startKey) break;
        }
        return path[0] === startKey ? path : null;
      }
      queue.push(key);
    }
  }

  return null;
}

export function pickRandom(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx] || null;
}

