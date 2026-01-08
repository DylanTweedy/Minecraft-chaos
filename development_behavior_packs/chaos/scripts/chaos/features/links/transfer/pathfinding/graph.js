// scripts/chaos/features/links/transfer/pathfinding/graph.js
import { BEAM_ID, CRYSTALLIZER_ID, MAX_BEAM_LEN, isPrismBlock } from "../config.js";

export function getNodeType(id, block = null) {
  // Use block if provided for more accurate check
  if (block && isPrismBlock(block)) return "prism";
  if (isPrismBlock({ typeId: id })) return "prism";
  if (id === CRYSTALLIZER_ID) return "crystal";
  return null;
}

export function allowAdjacentNode(curType, nodeType) {
  // All prisms can connect to each other and crystallizers
  if (curType === "prism" || nodeType === "prism") return true;
  if (curType === "crystal" || nodeType === "crystal") return true;
  return false;
}

export function scanEdgeFromNode(dim, loc, dir, curNodeType) {
  const path = [];
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dir.dx * i;
    const y = loc.y + dir.dy * i;
    const z = loc.z + dir.dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === BEAM_ID) {
      path.push({ x, y, z });
      continue;
    }

    const nodeType = getNodeType(id, b);
    if (nodeType) {
      if (path.length === 0 && !allowAdjacentNode(curNodeType, nodeType)) return null;
      return {
        nodeType,
        nodePos: { x, y, z },
        path: path,
      };
    }

    break;
  }
  return null;
}

export function makeDirs() {
  return [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
}
