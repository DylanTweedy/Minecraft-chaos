// scripts/chaos/items/insightLens.js
// Insight Lens interaction handler
// Lens enables basic debug visibility (warnings and debug logs)
// Crouch + right-click opens menu to toggle extended debugging groups

import { EquipmentSlot, EntityComponentTypes } from "@minecraft/server";
import { showDebugMenu } from "../core/debugMenu.js";

const LENS_ID = "chaos:insight_lens";
const MAX_OBSERVATION_DISTANCE = 32;

/**
 * Handle right-click with Insight Lens
 * Only crouch + right-click opens menu (no other interactions)
 */
export function handleInsightLensUseOn(e, deps) {
  try {
    const player = e?.source;
    if (!player || player.typeId !== "minecraft:player") return;

    const item = e?.itemStack;
    if (!item || item.typeId !== LENS_ID) return;

    // Only crouch + right-click opens the debug menu
    if (player.isSneaking) {
      showDebugMenu(player).catch(() => {});
    }
    // Normal right-click does nothing (allows normal block interaction)
  } catch {
    // ignore
  }
}

/**
 * Check if player is holding Insight Lens (main hand or offhand)
 */
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
          if (mainItem && mainItem.typeId === LENS_ID) {
            return true;
          }
        }
      }
    } catch (err) {
      // Continue to other methods
    }
    
    // Method 2: Check offhand via equippable component (primary method for offhand)
    try {
      const equippable = player.getComponent(EntityComponentTypes.Equippable) || player.getComponent("minecraft:equippable");
      if (equippable) {
        // Try PascalCase first (newer API), fallback to camelCase if needed
        let offhandItem = null;
        try {
          offhandItem = equippable.getEquipment(EquipmentSlot.Offhand);
        } catch {
          try {
            offhandItem = equippable.getEquipment(EquipmentSlot.offhand);
          } catch {}
        }
        if (offhandItem && offhandItem.typeId === LENS_ID) {
          return true;
        }
      }
    } catch (err) {
      // Continue
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Get block player is looking at (for observation mode)
 */
export function getTargetBlockForObservation(player) {
  try {
    const hit = player.getBlockFromViewDirection({ maxDistance: MAX_OBSERVATION_DISTANCE });
    return hit?.block || null;
  } catch {
    return null;
  }
}
