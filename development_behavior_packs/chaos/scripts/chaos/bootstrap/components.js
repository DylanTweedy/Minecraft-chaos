// scripts/chaos/bootstrap/components.js

import { EquipmentSlot, EntityComponentTypes, system } from "@minecraft/server";
import { handleDeathmarkUseEvent, handleDeathmarkUseOnEvent } from "../deathmark.js";
import { handleInsightLensUseOn } from "../items/insightLens.js";
import { handleGogglesUseOn, isWearingGoggles } from "../items/insightGoggles.js";
import { showDebugMenu } from "../core/debugMenu.js";

let mirrorRegistered = false;
let deathmarkRegistered = false;
let insightLensRegistered = false;
let insightGogglesRegistered = false;

export function registerMagicMirrorComponent(ctx) {
  if (mirrorRegistered) return;
  mirrorRegistered = true;

  const {
    system,
    world,
    MIRROR_ID,
    handleMirrorUse,
    handleMirrorUseOn,
    handleMirrorEntityAttack,
  } = ctx;

  // Component registration - primary method (like wand)
  system.beforeEvents.startup.subscribe((ev) => {
    try {
      ev.itemComponentRegistry.registerCustomComponent("chaos:magic_mirror_logic", {
        onUseOn: (e) => {
          try {
            const item = e.itemStack;
            if (!item) return;
            const itemId = item.typeId;
            if (itemId !== MIRROR_ID) return;
            handleMirrorUseOn(e, {
              MIRROR_ID,
              world,
            });
          } catch (err) {
            // ignore
          }
        },
      });
    } catch (err) {
      // ignore
    }
  });

  // Note: itemUseOn is handled by component callback (onUseOn)
  // No need to subscribe to world.afterEvents.itemUseOn if component handles it

  try {
    world.afterEvents.itemUse.subscribe((e) => {
      try {
        const item = e.itemStack;
        if (!item) return;
        const itemId = item.typeId;
        if (itemId !== MIRROR_ID) return;
        // Only handle if no block was clicked (air use)
        if (!e.block) {
          handleMirrorUse(e, {
            MIRROR_ID,
            world,
          });
        }
      } catch (err) {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  // Subscribe to entity hurt event to detect when player attacks entities with mirror
  // Note: We accept that entities will take damage - cancellation/healing doesn't work reliably in Bedrock
  try {
    if (world.afterEvents && typeof world.afterEvents.entityHurt !== "undefined") {
      world.afterEvents.entityHurt.subscribe((e) => {
        try {
          const hurtEntity = e.hurtEntity;
          const damageSource = e.damageSource;
          const attacker = damageSource?.damagingEntity;
          
          // Only handle if attacker is a player
          if (!attacker || attacker.typeId !== "minecraft:player") return;
          
          const player = attacker;
          
          // Check if player is holding the mirror
          const inventory = player.getComponent?.("minecraft:inventory");
          const container = inventory?.container;
          if (!container) return;
          
          const selectedSlot = player.selectedSlotIndex || 0;
          const itemStack = container.getItem(selectedSlot);
          if (!itemStack) return;
          
          const itemId = itemStack.typeId;
          if (itemId !== MIRROR_ID) return;
          
          // Handle teleport
          const attackEvent = {
            player: player,
            attackedEntity: hurtEntity,
          };
          
          handleMirrorEntityAttack(attackEvent, {
            MIRROR_ID,
            world,
          });
        } catch (err) {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }
}

export function registerDeathmarkComponent(system) {
  if (deathmarkRegistered) return;
  deathmarkRegistered = true;

  // Component registration
  system.beforeEvents.startup.subscribe((ev) => {
    try {
      ev.itemComponentRegistry.registerCustomComponent("chaos:deathmark_logic", {
        onUse: (e) => {
          try {
            handleDeathmarkUseEvent(e);
          } catch {
            // ignore
          }
        },
        onUseOn: (e) => {
          try {
            handleDeathmarkUseOnEvent(e);
          } catch {
            // ignore
          }
        },
      });
    } catch {
      // ignore
    }
  });
}

export function registerInsightLensComponent(ctx) {
  if (insightLensRegistered) return;
  insightLensRegistered = true;

  const { system, world } = ctx;

  // Register component (required for item registration, but minimal callback)
  system.beforeEvents.startup.subscribe((ev) => {
    try {
      ev.itemComponentRegistry.registerCustomComponent("chaos:insight_lens_logic", {
        onUseOn: (e) => {
          // Minimal callback - actual handling done in beforeEvents for better control
        },
      });
    } catch {
      // ignore
    }
  });

  // Helper function to check if lens is in offhand
  function hasLensInOffhand(player) {
    try {
      const equippable = player.getComponent(EntityComponentTypes.Equippable) || player.getComponent("minecraft:equippable");
      if (equippable) {
        let offhandItem = null;
        try {
          offhandItem = equippable.getEquipment(EquipmentSlot.Offhand);
        } catch {
          try {
            offhandItem = equippable.getEquipment(EquipmentSlot.offhand);
          } catch {}
        }
        return offhandItem?.typeId === "chaos:insight_lens";
      }
    } catch {}
    return false;
  }

  // Handle playerInteractWithBlock for lens in offhand (when using other items)
  try {
    if (world.beforeEvents && world.beforeEvents.playerInteractWithBlock) {
      world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
        try {
          const player = ev.player;
          if (!player || player.typeId !== "minecraft:player") return;
          
          // Check if lens is in offhand
          if (!hasLensInOffhand(player)) return;
          
          // Crouch + right-click with lens in offhand = open menu (cancel block interaction)
          if (player.isSneaking && ev.block) {
            ev.cancel = true; // Prevent block interaction when opening menu
            // Schedule menu show in unrestricted execution context (ActionFormData requires this)
            system.run(() => {
              showDebugMenu(player).catch(() => {});
            });
          }
          // Normal right-click: allow normal block interaction (lens in offhand just enables debug visibility)
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  // Handle itemUseOn when lens is in main hand OR offhand
  try {
    if (world.beforeEvents && world.beforeEvents.itemUseOn) {
      world.beforeEvents.itemUseOn.subscribe((ev) => {
        try {
          const player = ev?.source;
          if (!player || player.typeId !== "minecraft:player") return;

          const item = ev?.itemStack;
          const isLensInMainHand = item && item.typeId === "chaos:insight_lens";
          const isLensInOffhand = hasLensInOffhand(player);
          
          // Must be using lens in main hand OR have lens in offhand
          if (!isLensInMainHand && !isLensInOffhand) return;

          const block = ev?.block;

          // Crouch + right-click = open menu (cancel block interaction)
          if (player.isSneaking) {
            if (block) {
              ev.cancel = true; // Prevent block interaction when opening menu
            }
            // Schedule menu show in unrestricted execution context (ActionFormData requires this)
            system.run(() => {
              showDebugMenu(player).catch(() => {});
            });
            return;
          }

          // Normal right-click: allow normal block interaction
          // (lens in offhand just enables debug visibility, no special action needed)
          if (isLensInMainHand && block) {
            handleInsightLensUseOn(ev, { world });
            // Don't cancel - allow normal block interaction to proceed
          }
          // Air clicks handled in itemUse event below
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  // Handle itemUse event for right-clicking air (when lens is held in main hand or offhand)
  try {
    world.afterEvents.itemUse.subscribe((e) => {
      try {
        const player = e.source;
        if (!player || player.typeId !== "minecraft:player") return;
        
        const item = e.itemStack;
        const isLensInMainHand = item && item.typeId === "chaos:insight_lens";
        const isLensInOffhand = hasLensInOffhand(player);
        
        // Must be using lens in main hand OR have lens in offhand
        if (!isLensInMainHand && !isLensInOffhand) return;
        
        // Only crouch + use (air) opens menu
        if (player.isSneaking && !e.block) {
          // Schedule menu show in unrestricted execution context (ActionFormData requires this)
          system.run(() => {
            showDebugMenu(player).catch(() => {});
          });
        }
        // Normal use (air) does nothing
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

export function registerInsightGogglesComponent(ctx) {
  if (insightGogglesRegistered) return;
  insightGogglesRegistered = true;

  const { system, world } = ctx;

  // Register component (required for item registration, but minimal callback)
  system.beforeEvents.startup.subscribe((ev) => {
    try {
      ev.itemComponentRegistry.registerCustomComponent("chaos:insight_goggles_logic", {
        onUseOn: (e) => {
          // Minimal callback - actual handling done in beforeEvents for better control
        },
      });
    } catch {
      // ignore
    }
  });

  // Handle playerInteractWithBlock for goggles (when wearing and crouching)
  try {
    if (world.beforeEvents && world.beforeEvents.playerInteractWithBlock) {
      world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
        try {
          const player = ev?.player;
          if (!player || player.typeId !== "minecraft:player") return;

          // Only handle if wearing goggles AND crouching
          if (!isWearingGoggles(player)) return;
          if (!player.isSneaking) return;

          // Crouch + right-click = open menu (cancel block interaction)
          ev.cancel = true;
          // Schedule menu show in unrestricted execution context (ActionFormData requires this)
          system.run(() => {
            showDebugMenu(player).catch(() => {});
          });
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  // Handle beforeEvents.itemUseOn for goggles item (when holding it)
  try {
    if (world.beforeEvents && world.beforeEvents.itemUseOn) {
      world.beforeEvents.itemUseOn.subscribe((ev) => {
        try {
          const item = ev?.itemStack;
          if (!item || item.typeId !== "chaos:insight_goggles") return;

          const player = ev?.source;
          if (!player || player.typeId !== "minecraft:player") return;

          const block = ev?.block;

          // Crouch + right-click = open menu (cancel block interaction)
          if (player.isSneaking) {
            if (block) {
              ev.cancel = true; // Prevent block interaction when opening menu
            }
            // Schedule menu show in unrestricted execution context (ActionFormData requires this)
            system.run(() => {
              showDebugMenu(player).catch(() => {});
            });
            return;
          }

          // Normal right-click on block = toggle debug group but allow normal interaction
          if (block) {
            handleGogglesUseOn(ev, { world });
            // Don't cancel - allow normal block interaction to proceed
          }
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  // Handle itemUse event for right-clicking air (with goggles item or when wearing goggles) - only for crouch menu
  try {
    world.afterEvents.itemUse.subscribe((e) => {
      try {
        const player = e.source;
        if (!player || player.typeId !== "minecraft:player") return;

        const item = e.itemStack;
        const isUsingGogglesItem = item && item.typeId === "chaos:insight_goggles";
        const isWearing = isWearingGoggles(player);

        // Must be using goggles item OR wearing goggles
        if (!isUsingGogglesItem && !isWearing) return;

        // Only handle air use (no block)
        if (e.block) return;

        // Only crouch + use (air) opens menu
        if (player.isSneaking) {
          // Schedule menu show in unrestricted execution context (ActionFormData requires this)
          system.run(() => {
            showDebugMenu(player).catch(() => {});
          });
        }
        // Normal use (air) does nothing
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}
