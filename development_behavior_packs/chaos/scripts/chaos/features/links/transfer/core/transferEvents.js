// scripts/chaos/features/links/transfer/core/transferEvents.js

/**
 * Subscribes to world events once, and marks adjacent prisms dirty when containers change.
 * Returns an unsubscribe function (best-effort; Bedrock events don't always support unsub cleanly).
 *
 * IMPORTANT: This MUST be "subscribe once" to avoid duplicate handlers.
 */
export function subscribeTransferDirtyEvents(deps) {
  const world = deps?.world;
  const cacheManager = deps?.cacheManager;

  const markAdjacentPrismsDirty = deps?.markAdjacentPrismsDirty;
  const getInventoryContainer = deps?.getInventoryContainer;
  const isFurnaceBlock = deps?.isFurnaceBlock;
  const logError = deps?.logError || (() => {});
  const debugLog = deps?.debugLog || (() => {});

  if (!world?.afterEvents) return () => {};

  // Guard: prevent multiple subscriptions
  if (deps?.state) {
    if (deps.state.eventsSubscribed) return () => {};
    deps.state.eventsSubscribed = true;
  }

  const subs = [];

  function invalidateBlockSafe(dim, loc) {
    try {
      if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
        cacheManager.invalidateBlock(dim.id, loc);
      }
    } catch {}
  }

  function isContainerish(block) {
    try {
      if (!block) return false;
      // furnace check first (you already treat these as special)
      if (typeof isFurnaceBlock === "function" && isFurnaceBlock(block)) return true;
      // normal container check
      if (typeof getInventoryContainer === "function") {
        const c = getInventoryContainer(block);
        if (c) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Player places block
  try {
    const evt = world.afterEvents.playerPlaceBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const block = ev?.block;
          if (!block) return;

          if (!isContainerish(block)) return;

          markAdjacentPrismsDirty?.(block.dimension, block.location, "player_placed_container");
          invalidateBlockSafe(block.dimension, block.location);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "playerPlaceBlock" });
    }
  } catch (err) {
    logError("Error subscribing to playerPlaceBlock", err);
  }

  // Player breaks block
  try {
    const evt = world.afterEvents.playerBreakBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const dim = ev?.dimension;
          const loc = ev?.block?.location;
          if (!dim || !loc) return;

          // We can't reliably test "was container" from permutation; be conservative.
          markAdjacentPrismsDirty?.(dim, loc, "player_broke_block");
          invalidateBlockSafe(dim, loc);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "playerBreakBlock" });
    }
  } catch (err) {
    logError("Error subscribing to playerBreakBlock", err);
  }

  // Entity places block (if supported)
  try {
    const evt = world.afterEvents.entityPlaceBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const block = ev?.block;
          if (!block) return;

          if (!isContainerish(block)) return;

          markAdjacentPrismsDirty?.(block.dimension, block.location, "entity_placed_container");
          invalidateBlockSafe(block.dimension, block.location);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "entityPlaceBlock" });
    }
  } catch (err) {
    logError("Error subscribing to entityPlaceBlock", err);
  }

  debugLog?.(`[TransferEvents] subscribed: ${subs.map(s => s.name).join(", ")}`);

  // Best-effort unsubscribe (Bedrock doesn't always support unsubscribe)
  return () => {
    try {
      for (const s of subs) {
        try {
          if (s?.evt && typeof s.evt.unsubscribe === "function") {
            s.evt.unsubscribe(s.cb);
          }
        } catch {}
      }
      if (deps?.state) deps.state.eventsSubscribed = false;
    } catch {}
  };
}
