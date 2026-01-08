// scripts/chaos/bootstrap/bootChaos.js
// Safe bootstrap: no DP at import-time; everything runs after startup tick.

export function bootChaos(deps) {
  try {
    const {
      world,
      system,
      loadPairsFromWorldSafe,
      isPersistenceEnabled,
      getPairsMap,
      getGlobalInputCount,
      getGlobalLinkCount,
      onReady,
    } = deps;

    system.runTimeout(() => {
      world.sendMessage("§a[Chaos] Script loaded ✅");

      system.runTimeout(() => {
        loadPairsFromWorldSafe();

        try {
          if (onReady) onReady();
        } catch {
          // ignore
        }

        const persistenceStatus = isPersistenceEnabled() ? "§aON" : "§cOFF";
        world.sendMessage(
          `§b[Chaos] Pairs loaded. Persistence: ${persistenceStatus}`
        );

        const map = getPairsMap();
        const inputs = getGlobalInputCount(map);
        const links = getGlobalLinkCount(map);

        world.sendMessage(
          `§7[Chaos] Current links: §f${links}§7 across §f${inputs}§7 inputs`
        );
      }, 1);
    }, 1);
  } catch {
    // If bootstrap fails, do nothing — better silent than crash.
  }
}
