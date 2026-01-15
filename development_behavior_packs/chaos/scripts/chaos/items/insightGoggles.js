// scripts/chaos/items/insightGoggles.js
// Insight Goggles worn detection and observation
// Insight is automatic (no menus or toggles).

import { EquipmentSlot, EntityComponentTypes } from "@minecraft/server";
const GOGGLES_ID = "chaos:insight_goggles";
/**
 * Check if player is wearing Insight Goggles
 * Checks helmet slot first (primary), then fallback checks
 */
export function isWearingGoggles(player) {
  try {
    if (!player || player.typeId !== "minecraft:player") return false;
    
    // Primary check: helmet slot (head)
    try {
      const equippable = player.getComponent(EntityComponentTypes.Equippable) || player.getComponent("minecraft:equippable");
      if (equippable) {
        // Try PascalCase first (newer API), fallback to camelCase if needed
        let helmet = null;
        let offhand = null;
        try {
          helmet = equippable.getEquipment(EquipmentSlot.Head);
        } catch {
          try {
            helmet = equippable.getEquipment(EquipmentSlot.head);
          } catch {}
        }
        if (helmet && helmet.typeId === GOGGLES_ID) {
          return true;
        }
        
        // Also check offhand while we have the equippable component
        try {
          offhand = equippable.getEquipment(EquipmentSlot.Offhand);
        } catch {
          try {
            offhand = equippable.getEquipment(EquipmentSlot.offhand);
          } catch {}
        }
        if (offhand && offhand.typeId === GOGGLES_ID) {
          return true;
        }
      }
    } catch (err) {
      // Silently fail - API might not be available
    }
    
    // Fallback: check if in hotbar and selected (for testing/debugging)
    try {
      const inv = player.getComponent("minecraft:inventory");
      const c = inv?.container;
      if (c) {
        const selectedItem = c.getItem(player.selectedSlotIndex);
        if (selectedItem && selectedItem.typeId === GOGGLES_ID) {
          return true;
        }
      }
    } catch (err) {
      // Silently fail
    }
    
    return false;
  } catch {
    return false;
  }
}

// Removed temporary groups functionality - goggles now just enable basic debug visibility

/**
 * Get block player is looking at (for observation mode)
 */
export function getTargetBlockForObservation(player) {
  try {
    const hit = player.getBlockFromViewDirection({ maxDistance: 32 });
    return hit?.block || null;
  } catch {
    return null;
  }
}

/**
 * Handle right-click interaction while wearing goggles or using goggles item
 * Only crouch + right-click opens menu (no other interactions)
 */
export function handleGogglesUseOn(e, deps) {
  // No-op: Insight v2 is automatic and context-aware.
  void e;
  void deps;
}
