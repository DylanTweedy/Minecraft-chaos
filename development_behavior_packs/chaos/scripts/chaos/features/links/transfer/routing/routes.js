// scripts/chaos/features/links/transfer/pathfinding/routes.js
import { CRYSTALLIZER_ID, CRYSTAL_ROUTE_MAX_NODES, isPrismBlock, isEndpointId } from "../config.js";
import { key, parseKey } from "../keys.js";
import { getAllAdjacentInventories } from "../inventory/inventory.js";

// Find route from a prism to another prism (or crystallizer) that can accept items
// Optional getPrismInventoriesCached function for cached inventory checks (from cache manager)
export function findPrismRouteFromNode(startBlock, dimId, getPrismInventoriesCached = null, linkGraph = null) {
  try {
    if (!startBlock || !dimId || !linkGraph) return null;
    const dim = startBlock.dimension;
    if (!dim) return null;
    const startPos = startBlock.location;
    const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

    const queue = [];
    let qIndex = 0;
    const visited = new Set();
    const parent = new Map();
    queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "prism", key: startKey });
    visited.add(startKey);

    while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
      const cur = queue[qIndex++];
      const neighbors = linkGraph.getNeighbors(cur.key, { includePending: false });
      for (const edge of neighbors) {
        const nextKey = edge.key;
        if (visited.has(nextKey)) continue;
        const parsed = parseKey(nextKey);
        if (!parsed) continue;

        visited.add(nextKey);
        parent.set(nextKey, {
          prevKey: cur.key,
          edgeId: edge.edgeId,
          nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
        });

        const targetBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
        const isPrism = isPrismBlock(targetBlock);
        const isEndpoint = targetBlock && isEndpointId(targetBlock.typeId);

        if (isPrism) {
          if (!targetBlock || !isPrismBlock(targetBlock)) {
            continue;
          }
          // Use cached inventory check if available, otherwise fall back to direct check
          const inventories = (typeof getPrismInventoriesCached === "function")
            ? getPrismInventoriesCached(nextKey, targetBlock, dim)
            : getAllAdjacentInventories(targetBlock, dim);
          if (inventories && inventories.length > 0) {
            return buildPrismRoute(startKey, nextKey, parent, linkGraph);
          }
        }

        if (isEndpoint) {
          return buildPrismRoute(startKey, nextKey, parent, linkGraph);
        }

        queue.push({ nodePos: { x: parsed.x, y: parsed.y, z: parsed.z }, nodeType: isEndpoint ? "endpoint" : "prism", key: nextKey });
        if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Legacy function name
export function findOutputRouteFromNode(startBlock, dimId, getPrismInventoriesCached = null, linkGraph = null) {
  return findPrismRouteFromNode(startBlock, dimId, getPrismInventoriesCached, linkGraph);
}

function buildPrismRoute(startKey, targetKey, parent, linkGraph) {
  try {
    const forward = linkGraph.buildPathFromParents(startKey, targetKey, parent);
    if (!forward || forward.length < 2) return null;
    const reversed = forward.slice().reverse();
    const outputPos = reversed[0];
    return {
      path: reversed,
      startIndex: reversed.length - 1,
      endIndex: 0,
      outputKey: targetKey,
      outputPos: { x: outputPos.x, y: outputPos.y, z: outputPos.z },
    };
  } catch {
    return null;
  }
}

// Legacy function name
function buildOutputRoute(startKey, targetKey, parent) {
  return buildPrismRoute(startKey, targetKey, parent);
}

export function findCrystallizerRouteFromPrism(prismBlock, dimId, linkGraph = null) {
  try {
    if (!prismBlock || !dimId || !linkGraph) return null;
    const dim = prismBlock.dimension;
    if (!dim) return null;
    const startPos = prismBlock.location;
    const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

    const queue = [];
    let qIndex = 0;
    const visited = new Set();
    const parent = new Map();
    queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "prism", key: startKey });
    visited.add(startKey);

    while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
      const cur = queue[qIndex++];
      const neighbors = linkGraph.getNeighbors(cur.key, { includePending: false });
      for (const edge of neighbors) {
        const nextKey = edge.key;
        if (visited.has(nextKey)) continue;
        const parsed = parseKey(nextKey);
        if (!parsed) continue;
        visited.add(nextKey);
        parent.set(nextKey, {
          prevKey: cur.key,
          edgeId: edge.edgeId,
          nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
        });
        const targetBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
        if (targetBlock && isEndpointId(targetBlock.typeId)) {
          return buildCrystallizerRoute(startKey, nextKey, parent, linkGraph);
        }
        queue.push({ nodePos: { x: parsed.x, y: parsed.y, z: parsed.z }, nodeType: "prism", key: nextKey });
        if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildCrystallizerRoute(startKey, targetKey, parent, linkGraph) {
  try {
    const forward = linkGraph.buildPathFromParents(startKey, targetKey, parent);
    if (!forward || forward.length < 2) return null;
    const reversed = forward.slice().reverse();
    const crystalPos = reversed[0];
    return {
      path: reversed,
      outputIndex: reversed.length - 1,
      targetIndex: 0,
      crystalPos: { x: crystalPos.x, y: crystalPos.y, z: crystalPos.z },
    };
  } catch {
    return null;
  }
}

// Legacy function name
export function findCrystallizerRouteFromOutput(outputBlock, dimId, linkGraph = null) {
  return findCrystallizerRouteFromPrism(outputBlock, dimId, linkGraph);
}
