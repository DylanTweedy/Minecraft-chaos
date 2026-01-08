// scripts/chaos/bootstrap/components.js
import { world } from "@minecraft/server";

let registered = false;

export function registerWandComponent(ctx) {
  try {
    if (registered) {
      world.sendMessage("§7[Chaos] Wand component already registered, skipping");
      return;
    }
    registered = true;

    const {
      system,
      isPairsReady,
      WAND_ID,
      isPrismBlock,
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
    try {
      system.beforeEvents.startup.subscribe((ev) => {
        try {
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
                isPrismBlock,

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
          world.sendMessage("§7[Chaos] Wand component registered in startup event");
        } catch (err) {
          world.sendMessage(`§c[Chaos] ERROR registering wand component: ${err?.message || String(err)}`);
        }
      });
    } catch (err) {
      world.sendMessage(`§c[Chaos] ERROR subscribing to startup event: ${err?.message || String(err)}`);
    }
  } catch (err) {
    world.sendMessage(`§c[Chaos] FATAL ERROR in registerWandComponent(): ${err?.message || String(err)}`);
  }
}
