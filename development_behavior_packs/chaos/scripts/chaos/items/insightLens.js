// scripts/chaos/items/insightLens.js
// Insight Lens interaction handler
// Insight is now automatic (no menus or toggles).

import { EquipmentSlot, EntityComponentTypes } from "@minecraft/server";
const LENS_ID = "chaos:insight_lens";
const MAX_OBSERVATION_DISTANCE = 32;

export function handleInsightLensUseOn(e, deps) {
  // No-op: Insight v2 is automatic and context-aware.
  void e;
  void deps;
}

export function isHoldingLens(player) {
  try {
    if (!player || player.typeId !== "minecraft:player") return false;

    // Method 1: Check main hand via inventory selected slot
    try {
      const inv = player.getComponent("minecraft:inventory");
      const c = inv?.container;
      if (c) {
        const slotIndex = player.selectedSlotIndex;
        if (slotIndex >= 0 && slotIndex < c.size) {
          const mainItem = c.getItem(slotIndex);
          if (mainItem && mainItem.typeId === LENS_ID) return true;
        }
      }
    } catch {}

    // Method 2: Check offhand
    try {
      const equippable =
        player.getComponent(EntityComponentTypes.Equippable) ||
        player.getComponent("minecraft:equippable");
      if (equippable) {
        let offhandItem = null;
        try {
          offhandItem = equippable.getEquipment(EquipmentSlot.Offhand);
        } catch {
          try {
            offhandItem = equippable.getEquipment(EquipmentSlot.offhand);
          } catch {}
        }
        if (offhandItem && offhandItem.typeId === LENS_ID) return true;
      }
    } catch {}

    return false;
  } catch {
    return false;
  }
}

export function getTargetBlockForObservation(player) {
  try {
    const hit = player.getBlockFromViewDirection({ maxDistance: MAX_OBSERVATION_DISTANCE });
    return hit?.block || null;
  } catch {
    return null;
  }
}
