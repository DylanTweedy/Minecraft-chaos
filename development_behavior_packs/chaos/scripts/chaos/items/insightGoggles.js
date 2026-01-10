// scripts/chaos/items/insightGoggles.js
// Insight Goggles worn detection and observation
// Goggles enable basic debug visibility (warnings and debug logs)
// Crouch + right-click opens menu to toggle extended debugging groups

import { EquipmentSlot, EntityComponentTypes } from "@minecraft/server";
import { showDebugMenu } from "../core/debugMenu.js";

const GOGGLES_ID = "chaos:insight_goggles";
const WAND_ID = "chaos:wand";
const PRISM_ITEM_IDS = [
  "chaos:prism_1",
  "chaos:prism_2",
  "chaos:prism_3",
  "chaos:prism_4",
  "chaos:prism_5",
];

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
  try {
    const player = e?.source || e?.player;
    if (!player || player.typeId !== "minecraft:player") return;

    // Check if using goggles item or wearing goggles
    const item = e?.itemStack;
    const isUsingGogglesItem = item && item.typeId === "chaos:insight_goggles";
    const isWearing = isWearingGoggles(player);
    
    // Must be using goggles item OR wearing goggles
    if (!isUsingGogglesItem && !isWearing) return;

    // Only crouch + right-click opens the debug menu
    if (player.isSneaking) {
      showDebugMenu(player).catch(() => {});
    }
    // Normal right-click does nothing (allows normal block interaction)
  } catch {
    // ignore
  }
}
