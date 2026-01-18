// scripts/chaos/features/links/transfer/runtime/helpers/items.js

import { ItemStack } from "@minecraft/server";

export function createDropItemAt(deps) {
  const { findDropLocation } = deps || {};

  return function dropItemAt(dim, loc, typeId, amount) {
    try {
      const dropLoc = findDropLocation(dim, loc);

      let remaining = Math.max(1, amount | 0);
      let maxStack = 64;

      try {
        const probe = new ItemStack(typeId, 1);
        maxStack = probe.maxAmount || 64;
      } catch (e) {}

      while (remaining > 0) {
        const n = Math.min(maxStack, remaining);
        dim.spawnItem(new ItemStack(typeId, n), dropLoc);
        remaining -= n;
      }
    } catch (e) {
      // ignore
    }
  };
}
