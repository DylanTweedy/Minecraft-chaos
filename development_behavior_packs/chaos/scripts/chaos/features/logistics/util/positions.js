// scripts/chaos/features/logistics/util/positions.js
import { ItemStack } from "@minecraft/server";

export function computeEdgePosition(fromPos, dir, progress) {
  if (!fromPos || !dir) return null;
  return {
    x: fromPos.x + dir.dx * progress,
    y: fromPos.y + dir.dy * progress,
    z: fromPos.z + dir.dz * progress,
  };
}

export function dropItemAt(dim, pos, typeId, amount) {
  try {
    if (!dim || !pos || !typeId) return;
    let remaining = Math.max(1, amount | 0);
    let maxStack = 64;
    try {
      const probe = new ItemStack(typeId, 1);
      maxStack = probe.maxAmount || 64;
    } catch (e) {}
    while (remaining > 0) {
      const n = Math.min(maxStack, remaining);
      dim.spawnItem(new ItemStack(typeId, n), {
        x: pos.x + 0.5,
        y: pos.y + 0.5,
        z: pos.z + 0.5,
      });
      remaining -= n;
    }
  } catch (e) {
    // ignore
  }
}

