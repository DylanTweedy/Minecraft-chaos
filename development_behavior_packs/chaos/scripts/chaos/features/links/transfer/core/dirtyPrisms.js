// scripts/chaos/features/links/transfer/core/dirtyPrisms.js
import { key } from "../keys.js";
import { isPrismId } from "../config.js";

/**
 * Factory that returns a helper for marking prisms dirty when a nearby container changes.
 * Keeps controller.js slimmer and makes the behaviour reusable for future event hooks.
 *
 * @param {Object} deps
 * @param {any} deps.virtualInventoryManager
 * @param {(prismKey: string) => void=} deps.invalidateInput
 * @param {any=} deps.cacheManager
 * @returns {(dim: any, loc: {x:number,y:number,z:number}, reason?: string) => void}
 */
export function createAdjacentPrismDirtyMarker(deps) {
  const virtualInventoryManager = deps?.virtualInventoryManager;
  const invalidateInput = deps?.invalidateInput;
  const cacheManager = deps?.cacheManager;

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  return function markAdjacentPrismsDirty(dim, loc, reason = "container_changed") {
    try {
      if (!dim || !loc) return;

      for (const d of dirs) {
        const x = loc.x + d.dx;
        const y = loc.y + d.dy;
        const z = loc.z + d.dz;

        let block;
        try {
          block = dim.getBlock({ x, y, z });
        } catch {
          continue;
        }

        if (!block || !isPrismId(block.typeId)) continue;

        const prismKey = key(dim.id, x, y, z);

        try {
          if (virtualInventoryManager?.markPrismDirty) {
            virtualInventoryManager.markPrismDirty(prismKey, reason);
          }
        } catch {}

        try {
          if (typeof invalidateInput === "function") {
            invalidateInput(prismKey);
          }
        } catch {}

        try {
          if (cacheManager?.invalidatePrismInventories) {
            cacheManager.invalidatePrismInventories(prismKey);
          }
        } catch {}
      }
    } catch {
      // never throw
    }
  };
}
