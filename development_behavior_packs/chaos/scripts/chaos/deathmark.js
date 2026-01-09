// scripts/chaos/deathmark.js
// Deathmark system: creates item on player death, stores location, teleports on use

import { world, ItemStack } from "@minecraft/server";
import { teleportToSpawn } from "./features/magicMirror.js";

const DEATHMARK_ID = "chaos:deathmark";
const PROPERTY_KEY = "chaos:deathmark_location";

/**
 * Tries to add an item to a player's inventory
 * Returns true if successful, false otherwise
 */
function tryAddToInventory(player, itemStack) {
  try {
    if (!player || !itemStack) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;

    const size = inv.size;
    // Try to find an empty slot
    for (let i = 0; i < size; i++) {
      const existing = inv.getItem(i);
      if (!existing) {
        try {
          inv.setItem(i, itemStack);
          return true;
        } catch {
          continue;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Handles Deathmark item use (right-click in air or on block)
 * Reads stored location, teleports player, plays sound, and consumes item
 * If no death point is stored, teleports to spawn instead
 */
function handleDeathmarkUse(player, itemStack, slot) {
  try {
    if (!player || !itemStack || itemStack.typeId !== DEATHMARK_ID) return;

    let teleportLocation = null;
    let targetDim = null;
    let teleported = false;

    // Read location data from item
    const raw = itemStack.getDynamicProperty(PROPERTY_KEY);
    let hasValidData = false;

    if (raw && typeof raw === "string") {
      // Parse JSON
      try {
        const data = JSON.parse(raw);
        
        // Validate required fields
        if (
          data &&
          typeof data.x === "number" &&
          typeof data.y === "number" &&
          typeof data.z === "number" &&
          typeof data.dimId === "string"
        ) {
          // Get target dimension
          targetDim = world.getDimension(data.dimId);
          if (targetDim) {
            teleportLocation = { x: data.x, y: data.y, z: data.z };
            hasValidData = true;
          }
        }
      } catch {
        // Invalid JSON - will fall back to spawn
      }
    }

    // Teleport to death location if valid, otherwise teleport to spawn
    if (hasValidData && teleportLocation && targetDim) {
      // Teleport to stored death location
      try {
        player.teleport(teleportLocation, { dimension: targetDim });
        teleported = true;
      } catch {
        // Teleport failed - fall back to spawn
        hasValidData = false;
      }
    }

    // If no valid death location, teleport to spawn
    if (!hasValidData || !teleported) {
      try {
        const success = teleportToSpawn(player, { world });
        if (success) {
          teleported = true;
          // Get spawn location for sound
          const spawnLoc = player.location;
          if (spawnLoc) {
            teleportLocation = spawnLoc;
            targetDim = player.dimension;
          }
        }
      } catch {
        // Spawn teleport failed - silently ignore
      }
    }

    // If teleportation succeeded, play sound and consume item
    if (teleported) {
      // Play pop sound on consumption at destination location
      try {
        if (targetDim && teleportLocation) {
          targetDim.playSound("random.pop", teleportLocation);
        } else {
          player.playSound("random.pop");
        }
      } catch {
        try {
          player.playSound("random.pop");
        } catch {
          // ignore sound errors
        }
      }

      // Consume item
      const inv = player.getComponent("minecraft:inventory")?.container;
      if (inv && slot !== undefined) {
        const newAmount = (itemStack.amount || 1) - 1;
        if (newAmount <= 0) {
          // Remove item completely
          inv.setItem(slot, undefined);
        } else {
          // Reduce amount
          const updated = itemStack.clone();
          updated.amount = newAmount;
          inv.setItem(slot, updated);
        }
      }
    }
  } catch {
    // Silent failure by design
  }
}

/**
 * Handles player death - creates Deathmark with stored location
 */
function handlePlayerDeath(ev, system) {
  try {
    const entity = ev?.deadEntity;
    if (!entity || entity.typeId !== "minecraft:player") return;

    const loc = entity.location;
    const dim = entity.dimension;
    const dimId = dim?.id;
    if (!loc || !dimId) return;

    // Store player ID for delayed delivery
    const playerId = entity.id;

    // Create Deathmark item
    const item = new ItemStack(DEATHMARK_ID, 1);

    // Store location data as JSON
    const data = {
      x: loc.x,
      y: loc.y,
      z: loc.z,
      dimId: dimId,
    };
    item.setDynamicProperty(PROPERTY_KEY, JSON.stringify(data));

    // Try to give directly to inventory first (player might still be valid)
    const player = entity;
    if (tryAddToInventory(player, item)) {
      return; // Successfully added to inventory
    }

    // If direct inventory add failed, use delayed approach
    // Wait a few ticks for player to respawn, then try inventory again, then spawn
    system.runTimeout(() => {
      try {
        // Try to find the player by ID
        const players = world.getAllPlayers();
        let targetPlayer = null;
        for (const p of players) {
          if (p.id === playerId) {
            targetPlayer = p;
            break;
          }
        }

        if (targetPlayer && tryAddToInventory(targetPlayer, item)) {
          return; // Successfully added to inventory after respawn
        }

        // If still can't add to inventory, spawn at death location
        if (dim) {
          dim.spawnItem(item, loc);
        }
      } catch {
        // Fallback: spawn at death location
        try {
          if (dim) {
            dim.spawnItem(item, loc);
          }
        } catch {
          // Silent failure
        }
      }
    }, 5); // Wait 5 ticks for respawn
  } catch {
    // Silent failure by design
  }
}

/**
 * Starts the Deathmark system
 */
export function startDeathmarkSystem(world, system) {
  try {
    // Subscribe to player death events
    world.afterEvents.entityDie.subscribe((ev) => {
      handlePlayerDeath(ev, system);
    });

    // Fallback: Subscribe to itemUse event for right-click in air
    // (Component onUse should handle this, but this ensures it works)
    world.afterEvents.itemUse.subscribe((e) => {
      try {
        const player = e?.source;
        const itemStack = e?.itemStack;
        if (!player || !itemStack || itemStack.typeId !== DEATHMARK_ID) return;
        
        // Only handle if no block was clicked (air use)
        if (!e.block) {
          const slot = player.selectedSlotIndex ?? -1;
          if (slot >= 0) {
            handleDeathmarkUse(player, itemStack, slot);
          }
        }
      } catch {
        // ignore
      }
    });
  } catch {
    // Silent failure by design
  }
}

/**
 * Handler for component onUse event (right-click in air)
 */
export function handleDeathmarkUseEvent(e) {
  try {
    const player = e?.source;
    const itemStack = e?.itemStack;
    if (!player || !itemStack) return;

    // Get the selected slot index
    const slot = player.selectedSlotIndex ?? -1;
    if (slot < 0) return;

    handleDeathmarkUse(player, itemStack, slot);
  } catch {
    // Silent failure by design
  }
}

/**
 * Handler for component onUseOn event (right-click on block)
 */
export function handleDeathmarkUseOnEvent(e) {
  try {
    const player = e?.source;
    const itemStack = e?.itemStack;
    if (!player || !itemStack) return;

    // Get the selected slot index
    const slot = player.selectedSlotIndex ?? -1;
    if (slot < 0) return;

    handleDeathmarkUse(player, itemStack, slot);
  } catch {
    // Silent failure by design
  }
}
