// scripts/chaos/bootstrap/components.js

import { handleDeathmarkUseEvent, handleDeathmarkUseOnEvent } from "../deathmark.js";
import { handleInsightLensUseOn } from "../items/insightLens.js";

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

  // Handle itemUseOn when lens is in main hand OR offhand
  try {
    if (world.beforeEvents && world.beforeEvents.itemUseOn) {
      world.beforeEvents.itemUseOn.subscribe((ev) => {
        try {
          const player = ev?.source;
          if (!player || player.typeId !== "minecraft:player") return;

          const item = ev?.itemStack;
          const isLensInMainHand = item && item.typeId === "chaos:insight_lens";
          const isLensInOffhand = false;
          
          // Must be using lens in main hand OR have lens in offhand
          if (!isLensInMainHand && !isLensInOffhand) return;

          // Normal right-click: allow normal block interaction
          // (lens in offhand just enables debug visibility, no special action needed)
          if (isLensInMainHand && ev?.block) {
            handleInsightLensUseOn(ev, { world });
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

  // No extra air-use handling needed.
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

  // No goggles interaction menu in Insight v2.
}
