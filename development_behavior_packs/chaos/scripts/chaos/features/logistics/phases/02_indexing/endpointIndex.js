// scripts/chaos/features/logistics/phases/02_indexing/endpointIndex.js
import { CRYSTALLIZER_ID, CRUCIBLE_ID, isPrismBlock } from "../../config.js";

export function buildEndpointIndex(ctx) {
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const endpoints = {
    crystallizer: [],
    crucible: [],
  };

  if (!linkGraph || !cacheManager || typeof linkGraph.getNodeKeys !== "function") {
    ctx.indexes.endpointIndex = endpoints;
    return endpoints;
  }

  const nodeKeys = linkGraph.getNodeKeys();
  for (const nodeKey of nodeKeys) {
    const info = cacheManager.resolveBlockInfoCached(nodeKey);
    const block = info?.block;
    if (!block) continue;
    if (block.typeId === CRYSTALLIZER_ID) {
      endpoints.crystallizer.push(nodeKey);
      continue;
    }
    if (CRUCIBLE_ID && block.typeId === CRUCIBLE_ID) {
      endpoints.crucible.push(nodeKey);
      continue;
    }
    if (isPrismBlock(block)) continue;
  }

  ctx.indexes.endpointIndex = endpoints;
  return endpoints;
}

