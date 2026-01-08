// scripts/chaos/bootstrap/components.js

let registered = false;

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
