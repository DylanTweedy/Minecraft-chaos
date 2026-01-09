// scripts/chaos/bootstrap/components.js

import { handleDeathmarkUseEvent, handleDeathmarkUseOnEvent } from "../deathmark.js";

let registered = false;
let mirrorRegistered = false;
let deathmarkRegistered = false;

export function registerWandComponent(ctx) {
  if (registered) return;
  registered = true;

  const {
    system,
    isPairsReady,
    WAND_ID,
    PRISM_ID,
    getPending,
    setPending,
    clearPending,
    toggleOutput,
    savePairsToWorldSafe,
    isPersistenceEnabled,
    getPairsMap,
    getGlobalInputCount,
    getGlobalLinkCount,
    getPerInputOutputCount,
    makeKeyFromBlock,
    pendingToKey,
    fxSelectInput,
    fxPairSuccess,
    handleWandUseOn,
    FX,
  } = ctx;

  // Component registration
  system.beforeEvents.startup.subscribe((ev) => {
    ev.itemComponentRegistry.registerCustomComponent("chaos:wand_logic", {
      onUseOn: (e) => {
        const player = e.source;
        if (!player || player.typeId !== "minecraft:player") return;

        if (!isPairsReady()) {
          player.sendMessage("¶õe[Chaos] Loading links... try again in a moment.");
          return;
        }

        handleWandUseOn(e, {
          WAND_ID,
          PRISM_ID,

          getPending,
          setPending,
          clearPending,

          toggleOutput,
          savePairsToWorldSafe,
          isPersistenceEnabled,
          getPairsMap,

          getGlobalInputCount,
          getGlobalLinkCount,
          getPerInputOutputCount,

          makeKeyFromBlock,
          pendingToKey,

          fxSelectInput,
          fxPairSuccess,
          FX,

          system,
        });
      },
    });
  });
}

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

  // Subscribe to beforeEvents.entityHurt to cancel damage and handle mirror interaction
  try {
    if (world.beforeEvents && typeof world.beforeEvents.entityHurt !== "undefined") {
      world.beforeEvents.entityHurt.subscribe((e) => {
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
          
          // Cancel the damage
          e.cancel = true;
          
          // Create event-like object for our handler
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
