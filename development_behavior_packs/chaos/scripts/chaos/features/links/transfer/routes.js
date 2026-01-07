// scripts/chaos/features/links/transfer/routes.js
import { OUTPUT_ID, CRYSTALLIZER_ID, CRYSTAL_ROUTE_MAX_NODES } from "./config.js";
import { key, parseKey, getContainerKey } from "./keys.js";
import { makeDirs, scanEdgeFromNode } from "./graph.js";
import { getAttachedInventoryInfo } from "./inventory.js";

export function findOutputRouteFromNode(startBlock, dimId) {
  try {
    if (!startBlock || !dimId) return null;
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
      const dirs = makeDirs();
      for (const d of dirs) {
        const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
        if (!edge) continue;
        const nextKey = key(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
        if (visited.has(nextKey)) continue;
        visited.add(nextKey);
        parent.set(nextKey, {
          prevKey: cur.key,
          edgePath: edge.path,
          nodePos: { x: edge.nodePos.x, y: edge.nodePos.y, z: edge.nodePos.z },
          nodeType: edge.nodeType,
        });

        if (edge.nodeType === "output") {
          const outBlock = dim.getBlock(edge.nodePos);
          if (!outBlock || outBlock.typeId !== OUTPUT_ID) {
            continue;
          }
          const cInfo = getAttachedInventoryInfo(outBlock, dim);
          const containerKey = cInfo?.block ? getContainerKey(cInfo.block) : null;
          if (!cInfo?.container || !containerKey) {
            continue;
          }
          return buildOutputRoute(startKey, nextKey, parent);
        }

        queue.push({ nodePos: edge.nodePos, nodeType: edge.nodeType, key: nextKey });
        if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildOutputRoute(startKey, targetKey, parent) {
  try {
    const steps = [];
    let curKey = targetKey;
    while (curKey && curKey !== startKey) {
      const info = parent.get(curKey);
      if (!info) break;
      steps.push(info);
      curKey = info.prevKey;
    }
    if (curKey !== startKey) return null;
    steps.reverse();

    const parsedStart = parseKey(startKey);
    if (!parsedStart) return null;
    const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];
    for (const step of steps) {
      if (Array.isArray(step.edgePath) && step.edgePath.length > 0) {
        for (const p of step.edgePath) forward.push({ x: p.x, y: p.y, z: p.z });
      }
      forward.push({ x: step.nodePos.x, y: step.nodePos.y, z: step.nodePos.z });
    }
    if (forward.length < 2) return null;

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

export function findCrystallizerRouteFromOutput(outputBlock, dimId) {
  try {
    if (!outputBlock || !dimId) return null;
    const dim = outputBlock.dimension;
    if (!dim) return null;
    const startPos = outputBlock.location;
    const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

    const queue = [];
    let qIndex = 0;
    const visited = new Set();
    const parent = new Map();
    queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "output", key: startKey });
    visited.add(startKey);

    while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
      const cur = queue[qIndex++];
      const dirs = makeDirs();
      for (const d of dirs) {
        const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
        if (!edge) continue;
        const nextKey = key(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
        if (visited.has(nextKey)) continue;
        visited.add(nextKey);
        parent.set(nextKey, {
          prevKey: cur.key,
          edgePath: edge.path,
          nodePos: { x: edge.nodePos.x, y: edge.nodePos.y, z: edge.nodePos.z },
          nodeType: edge.nodeType,
        });
        if (edge.nodeType === "crystal") {
          return buildCrystallizerRoute(startKey, nextKey, parent);
        }
        queue.push({ nodePos: edge.nodePos, nodeType: edge.nodeType, key: nextKey });
        if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildCrystallizerRoute(startKey, targetKey, parent) {
  try {
    const steps = [];
    let curKey = targetKey;
    while (curKey && curKey !== startKey) {
      const info = parent.get(curKey);
      if (!info) break;
      steps.push(info);
      curKey = info.prevKey;
    }
    if (curKey !== startKey) return null;
    steps.reverse();

    const parsedStart = parseKey(startKey);
    if (!parsedStart) return null;
    const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];
    for (const step of steps) {
      if (Array.isArray(step.edgePath) && step.edgePath.length > 0) {
        for (const p of step.edgePath) forward.push({ x: p.x, y: p.y, z: p.z });
      }
      forward.push({ x: step.nodePos.x, y: step.nodePos.y, z: step.nodePos.z });
    }
    if (forward.length < 2) return null;
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
