// scripts/chaos/items/insightLens.js
// Insight Lens interaction handler
// - Sneak + right-click: opens menu to toggle extended debugging groups
// - Normal right-click: toggles DEV MODE (persistent) for verbose startup diagnostics

import { EquipmentSlot, EntityComponentTypes } from "@minecraft/server";
import { showDebugMenu } from "../core/debugMenu.js";
import { toggleDevMode } from "../core/debugGroups.js";

const LENS_ID = "chaos:insight_lens";
const MAX_OBSERVATION_DISTANCE = 32;

export function handleInsightLensUseOn(e, deps) {
  try {
    const player = e?.source;
    if (!player || player.typeId !== "minecraft:player") return;

    const item = e?.itemStack;
    if (!item || item.typeId !== LENS_ID) return;

    // Sneak + use: open debug menu
    if (player.isSneaking) {
      showDebugMenu(player).catch(() => {});
      return;
    }

    // Normal use: toggle DEV MODE and cancel interaction so it doesn't also click blocks
    try {
      const enabled = toggleDevMode();
      player.sendMessage(`§b[Insight] Dev mode: ${enabled ? "§aON" : "§cOFF"}§b (persists on reload)`);
    } catch {
      player.sendMessage("§c[Insight] Failed to toggle dev mode");
    }

    // Cancel the use to prevent normal block interaction
    try { e.cancel = true; } catch {}
  } catch {
    // ignore
  }
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
