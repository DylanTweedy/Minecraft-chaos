// scripts/chaos/features/links/transfer/runtime/bootstrap/startup.js

export function createTransferStartup(deps) {
  const {
    system,
    world,
    getTickId,
    setTickId,
    onTick,
    levelsManager,
    inflight,
    fluxFxInflight,
    cacheManager,
    getInventoryContainer,
    isFurnaceBlock,
    markAdjacentPrismsDirty,
    loadInflightState,
    loadLevelsState,
    loadOutputLevelsState,
    loadPrismLevelsState,
    sendInitMessage,
    logError,
    prismRegistry,
    linkGraph,
  } = deps || {};

  function start() {
    // INIT DEBUG: Start function called
    try {
      const hasLevels = !!levelsManager;
      const currentTickId = typeof getTickId === "function" ? getTickId() : null;
      sendInitMessage("§b[Init] start() called - tickId=" + currentTickId + ", levelsManager=" + hasLevels);
    } catch (e) {}

    const currentTickId = typeof getTickId === "function" ? getTickId() : null;
    if (currentTickId !== null) {
      try {
        sendInitMessage("§e[Init] Already started (tickId=" + currentTickId + ") - skipping");
      } catch (e) {}
      return;
    }

    if (!levelsManager) {
      logError("ERROR: Cannot start - levelsManager is null!", new Error("levelsManager is null"));
      return; // Don't start if levelsManager is null
    }

    // INIT DEBUG: Loading persistence
    sendInitMessage("§b[Init] Loading persistence (inflight, levels)...");

    // Retry loading persistence with exponential backoff (for world load scenarios)
    const maxRetries = 3;
    const retryDelays = [5, 10, 20]; // ticks to wait before retry

    function attemptLoadWithRetry(loadFn, name, retryIndex = 0) {
      // INIT DEBUG: Loading attempt
      try {
        const attemptNum = retryIndex + 1;
        const maxAttempts = maxRetries + 1;
        const nameStr = String(name || "unknown");
        sendInitMessage("§b[Init] Loading " + nameStr + " (attempt " + attemptNum + "/" + maxAttempts + ")...");
      } catch (e) {}

      try {
        loadFn();

        // INIT DEBUG: Success
        try {
          const nameStr = String(name || "unknown");
          sendInitMessage("§a[Init] V " + nameStr + " loaded successfully");
        } catch (e) {}
      } catch (err) {
        if (retryIndex < maxRetries) {
          const delay = retryDelays[retryIndex] || 20;

          // INIT DEBUG: Retrying
          try {
            const nameStr = String(name || "unknown");
            const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
            sendInitMessage("§e[Init] " + nameStr + " failed (" + errMsg + "), retrying in " + delay + " ticks...");
          } catch (e) {}

          // Retry after delay
          try {
            system.runTimeout(() => {
              attemptLoadWithRetry(loadFn, name, retryIndex + 1);
            }, delay);
          } catch (e) {
            logError("Error scheduling retry for " + (name || "unknown"), err);
          }
        } else {
          try {
            const nameStr = String(name || "unknown");
            logError("Error loading " + nameStr + " (after " + maxRetries + " retries)", err);
          } catch (e) {}
        }
      }
    }

    // Attempt to load state with retries
    attemptLoadWithRetry(() => loadInflightState(), "inflight state");
    attemptLoadWithRetry(() => loadLevelsState(), "levels state");
    attemptLoadWithRetry(() => loadOutputLevelsState(), "output levels state");
    attemptLoadWithRetry(() => loadPrismLevelsState(), "prism levels state");

    // INIT DEBUG: Persistence loaded, starting tick loop
    sendInitMessage("§b[Init] Persistence loaded. Starting tick loop (runInterval)...");
    try {
      if (prismRegistry && typeof prismRegistry.markAllForValidation === "function") {
        prismRegistry.markAllForValidation();
      }
      if (linkGraph && prismRegistry && typeof linkGraph.markNodeDirty === "function") {
        const keys = prismRegistry.resolvePrismKeys?.() || [];
        for (const k of keys) linkGraph.markNodeDirty(k);
      }
    } catch (e) {}

    try {
      const newTickId = system.runInterval(onTick, 1);
      if (typeof setTickId === "function") {
        setTickId(newTickId);
      }

      // INIT DEBUG: Tick loop started
      try {
        const inflightLen = (inflight && inflight.length) ? inflight.length : 0;
        const fluxFxLen = (fluxFxInflight && fluxFxInflight.length) ? fluxFxInflight.length : 0;
        sendInitMessage(
          "§a[Init] V Tick loop started! tickId=" +
            newTickId +
            ", inflight=" +
            inflightLen +
            ", fluxFxInflight=" +
            fluxFxLen
        );
      } catch (e) {}

      // Debug messages are emitted later via postDebugStats only
    } catch (err) {
      logError("Error starting tick interval", err);
    }
  }

  return { start };
}

