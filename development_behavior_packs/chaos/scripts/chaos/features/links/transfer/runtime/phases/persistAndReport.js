// scripts/chaos/features/links/transfer/runtime/phases/persistAndReport.js

import { ok, phaseStep } from "../helpers/result.js";

export function createPersistAndReportPhase(deps) {
  const handler = createPersistAndReportHandler(deps);

  return {
    name: "persistAndReport",
    run(ctx) {
      phaseStep(ctx, "persistAndReport");
      return handler(ctx);
    },
  };
}

function createPersistAndReportHandler(deps) {
  const {
    cfg,
    world,
    inflight,
    persistInflightStateToWorld,
    getInflightDirty,
    getInflightStepDirty,
    setInflightDirty,
    setInflightStepDirty,
    getInflightLastSaveTick,
    setInflightLastSaveTick,
    transferCounts,
    outputCounts,
    prismCounts,
    saveInputLevels,
    saveOutputLevels,
    savePrismLevels,
    getLevelsDirty,
    setLevelsDirty,
    getLevelsLastSaveTick,
    setLevelsLastSaveTick,
    getOutputLevelsDirty,
    setOutputLevelsDirty,
    getOutputLevelsLastSaveTick,
    setOutputLevelsLastSaveTick,
    getPrismLevelsDirty,
    setPrismLevelsDirty,
    getPrismLevelsLastSaveTick,
    setPrismLevelsLastSaveTick,
    sendDiagnosticMessage,
    sendInitMessage,
    debugEnabled,
    debugState,
    debugInterval,
    getLastDebugTick,
    setLastDebugTick,
    inputQueuesManager,
    getQueueState,
    hasInsight,
    getNowTick,
    getLastTickEndTime,
    setLastTickEndTime,
    getConsecutiveLongTicks,
    setConsecutiveLongTicks,
    setEmergencyDisableTicks,
  } = deps || {};

  function persistCountsIfNeeded(
    getDirty,
    getLastSaveTick,
    setDirty,
    setLastSaveTick,
    countsMap,
    saveFn,
    minInterval = 200
  ) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    if (!getDirty() && (nowTick - getLastSaveTick()) < minInterval) return;

    const obj = {};
    for (const [k, v] of countsMap.entries()) obj[k] = v;

    saveFn(world, obj);
    if (debugEnabled) debugState.dpSaves++;

    setDirty(false);
    setLastSaveTick(nowTick);
  }

  function persistInflightIfNeeded() {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const inflightDirty = !!(typeof getInflightDirty === "function" && getInflightDirty());
    const inflightStepDirty = !!(typeof getInflightStepDirty === "function" && getInflightStepDirty());

    if (!inflightDirty && !inflightStepDirty) return;

    if (inflightDirty && inflight.length === 0) {
      persistInflightStateToWorld(world, inflight);
      if (debugEnabled) debugState.dpSaves++;
      if (typeof setInflightDirty === "function") setInflightDirty(false);
      if (typeof setInflightStepDirty === "function") setInflightStepDirty(false);
      if (typeof setInflightLastSaveTick === "function") setInflightLastSaveTick(nowTick);
      return;
    }

    const interval = Math.max(1, cfg.inflightSaveIntervalTicks | 0);
    const lastSave = typeof getInflightLastSaveTick === "function" ? getInflightLastSaveTick() : 0;
    if ((nowTick - lastSave) < interval) return;

    const estimatedSize = inflight.length * 800;
    if (estimatedSize > 400000) {
      sendDiagnosticMessage(
        "[PERF] ? SKIPPING inflight save: Too large (" +
          inflight.length +
          " entries, ~" +
          Math.round(estimatedSize / 1024) +
          "KB)",
        "transfer"
      );

      if (typeof setInflightDirty === "function") setInflightDirty(false);
      if (typeof setInflightStepDirty === "function") setInflightStepDirty(false);
      if (typeof setInflightLastSaveTick === "function") setInflightLastSaveTick(nowTick);
      return;
    }

    persistInflightStateToWorld(world, inflight);
    if (debugEnabled) debugState.dpSaves++;
    if (typeof setInflightDirty === "function") setInflightDirty(false);
    if (typeof setInflightStepDirty === "function") setInflightStepDirty(false);
    if (typeof setInflightLastSaveTick === "function") setInflightLastSaveTick(nowTick);
  }

  function persistLevelsIfNeeded() {
    persistCountsIfNeeded(
      getLevelsDirty,
      getLevelsLastSaveTick,
      setLevelsDirty,
      setLevelsLastSaveTick,
      transferCounts,
      saveInputLevels
    );
  }

  function persistOutputLevelsIfNeeded() {
    persistCountsIfNeeded(
      getOutputLevelsDirty,
      getOutputLevelsLastSaveTick,
      setOutputLevelsDirty,
      setOutputLevelsLastSaveTick,
      outputCounts,
      saveOutputLevels
    );
  }

  function persistPrismLevelsIfNeeded() {
    persistCountsIfNeeded(
      getPrismLevelsDirty,
      getPrismLevelsLastSaveTick,
      setPrismLevelsDirty,
      setPrismLevelsLastSaveTick,
      prismCounts,
      savePrismLevels
    );
  }
  function resetDebugState() {
    const zeroKeys = [
      "inputsScanned",
      "transfersStarted",
      "outputOptionsTotal",
      "outputOptionsMax",
      "orbSpawns",
      "orbFxSkipped",
      "fluxFxSpawns",
      "inputMapReloads",
      "blockLookups",
      "containerLookups",
      "inventoryScans",
      "dpSaves",
      "fluxGenChecks",
      "fluxGenHits",
      "fluxRefineCalls",
      "fluxRefined",
      "fluxMutated",
      "msCache",
      "msQueues",
      "msInputQueues",
      "msInflight",
      "msFluxFx",
      "msScan",
      "msPersist",
      "msTotal",
      "balanceTransfers",
      "balanceCancelled",
      "balanceFallback",
      "balanceAmount",
    ];

    for (const k of zeroKeys) debugState[k] = 0;
    debugState.balanceCancelReason = null;
  }

  function postDebugStats(prismCount) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const interval = Math.max(20, Number(debugInterval) || 0) || 100;
    const lastTick = typeof getLastDebugTick === "function" ? getLastDebugTick() : 0;

    if (lastTick === 0) {
      if (typeof setLastDebugTick === "function") setLastDebugTick(nowTick);
      return;
    }

    if ((nowTick - lastTick) < interval) {
      return;
    }

    if (typeof setLastDebugTick === "function") setLastDebugTick(nowTick);

    try {
      const queueState = typeof getQueueState === "function" ? getQueueState() : null;
      const queueByContainer = queueState ? queueState.queueByContainer : new Map();

      let queuedContainers = 0;
      let queuedEntries = 0;
      let queuedItems = 0;
      for (const queue of queueByContainer.values()) {
        if (!queue) continue;
        queuedContainers++;
        queuedEntries += queue.length;
        for (const job of queue) {
          queuedItems += Math.max(0, job?.amount | 0);
        }
      }

      let inputQueueSize = 0;
      if (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function") {
        inputQueueSize = inputQueuesManager.getTotalQueueSize();
      }

      const timingBreakdown =
        "TIMING: Total=" +
        debugState.msTotal +
        "ms | Cache=" +
        (debugState.msCache || 0) +
        "ms | Queues=" +
        debugState.msQueues +
        "ms | InputQueues=" +
        (debugState.msInputQueues || 0) +
        "ms | Inflight=" +
        debugState.msInflight +
        "ms | FluxFX=" +
        debugState.msFluxFx +
        "ms | Scan=" +
        debugState.msScan +
        "ms | Persist=" +
        debugState.msPersist +
        "ms";

      const msg =
        "Transfer | xfer=" +
        debugState.transfersStarted +
        " inflight=" +
        (inflight ? inflight.length : 0) +
        " queues=" +
        inputQueueSize +
        " outputQ=" +
        queuedContainers +
        "/" +
        queuedItems +
        " | " +
        timingBreakdown;

      const players = world && typeof world.getAllPlayers === "function" ? world.getAllPlayers() : [];
      if (!players || players.length === 0) {
        resetDebugState();
        return;
      }

      for (const player of players) {
        try {
          if (!hasInsight || !hasInsight(player)) continue;
          if (typeof player.sendMessage === "function") {
            player.sendMessage(msg);
          }
        } catch (err) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(
                "§c[Chaos Transfer] Error sending stats: " + (err?.message || String(err))
              );
            }
          } catch {}
        }
      }

      resetDebugState();
    } catch (err) {
      try {
        const players = world && typeof world.getAllPlayers === "function" ? world.getAllPlayers() : [];
        for (const player of players) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(
                "§c[Chaos Transfer] Error in debug stats: " + (err?.message || String(err))
              );
            }
          } catch {}
        }
      } catch {}
    }
  }
  return function runPersistAndReport(ctx) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const tickStart = ctx?.tickStart || 0;
    const timeBeforePersist = ctx?.timeBeforePersist || 0;
    const shouldSkipSaves = ctx?.shouldSkipSaves === true;
    const prismCount = ctx?.prismCount | 0;
    const scanTotalTime = ctx?.scanTotalTime || 0;
    const cacheTime = ctx?.cacheTime || 0;
    const queuesTotalTime = ctx?.queuesTotalTime || 0;
    const virtualInvTime = ctx?.virtualInvTime || 0;
    const inputQueueTime = ctx?.inputQueueTime || 0;
    const prismCountSafe = prismCount >= 0 ? prismCount : 0;
    let consecutiveLongTicks =
      (typeof getConsecutiveLongTicks === "function") ? (getConsecutiveLongTicks() | 0) : 0;

    const persistStart = Date.now();
    let inflightSaveTime = 0;
    let levelsSaveTime = 0;
    let outputLevelsSaveTime = 0;
    let prismLevelsSaveTime = 0;

    if (!shouldSkipSaves) {
      const inflightSaveStart = Date.now();
      persistInflightIfNeeded();
      inflightSaveTime = Date.now() - inflightSaveStart;
      if (inflightSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistInflightIfNeeded: " + inflightSaveTime + "ms", "transfer");
      }

      const levelsSaveStart = Date.now();
      persistLevelsIfNeeded();
      levelsSaveTime = Date.now() - levelsSaveStart;
      if (levelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistLevelsIfNeeded: " + levelsSaveTime + "ms", "transfer");
      }

      const outputLevelsSaveStart = Date.now();
      persistOutputLevelsIfNeeded();
      outputLevelsSaveTime = Date.now() - outputLevelsSaveStart;
      if (outputLevelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistOutputLevelsIfNeeded: " + outputLevelsSaveTime + "ms", "transfer");
      }

      const prismLevelsSaveStart = Date.now();
      persistPrismLevelsIfNeeded();
      prismLevelsSaveTime = Date.now() - prismLevelsSaveStart;
      if (prismLevelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistPrismLevelsIfNeeded: " + prismLevelsSaveTime + "ms", "transfer");
      }
    } else {
      sendDiagnosticMessage(
        "[PERF] SKIPPING SAVES: Tick already at " + timeBeforePersist + "ms (>80ms threshold)",
        "transfer"
      );
    }

    const persistTime = Date.now() - persistStart;

    if (debugEnabled) {
      debugState.msPersist += persistTime;
      debugState.msTotal += (Date.now() - tickStart);

      try {
        postDebugStats(prismCountSafe);
      } catch (err) {
        sendInitMessage(
          "§c[Chaos Transfer] Error in postDebugStats: " +
            ((err && err.message) ? String(err.message) : String(err))
        );
      }
    }

    if (persistTime > 50 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] Persist Total: " +
          persistTime +
          "ms (Inflight: " +
          inflightSaveTime +
          "ms | InputLevels: " +
          levelsSaveTime +
          "ms | OutputLevels: " +
          outputLevelsSaveTime +
          "ms | PrismLevels: " +
          prismLevelsSaveTime +
          "ms)",
        "transfer"
      );
    }

    if (persistTime > 100) {
      sendDiagnosticMessage(
        "§e[PERF] WATCHDOG RISK: Persistence took " + persistTime + "ms (>100ms)",
        "transfer"
      );
    }

    const tickTotalTime = Date.now() - tickStart;
    if (typeof setLastTickEndTime === "function") {
      setLastTickEndTime(Date.now());
    }

    if (tickTotalTime > 80 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "§e[PERF] TICK TOTAL: " +
          tickTotalTime +
          "ms (Cache: " +
          cacheTime +
          "ms | Queues+Inflight: " +
          queuesTotalTime +
          "ms | VirtualInv: " +
          virtualInvTime +
          "ms | InputQueues: " +
          inputQueueTime +
          "ms | Scan: " +
          scanTotalTime +
          "ms | Persist: " +
          persistTime +
          "ms)",
        "transfer"
      );
    }

    if (tickTotalTime > 100) {
      consecutiveLongTicks++;
      if (typeof setConsecutiveLongTicks === "function") {
        setConsecutiveLongTicks(consecutiveLongTicks);
      }

      sendDiagnosticMessage(
        "§e[PERF] WATCHDOG RISK: Tick took " +
          tickTotalTime +
          "ms (>100ms threshold) [Consecutive: " +
          consecutiveLongTicks +
          "]",
        "transfer"
      );

      if (consecutiveLongTicks > 3) {
        sendDiagnosticMessage(
          "§c[PERF] CRITICAL: " +
            consecutiveLongTicks +
            " consecutive ticks >100ms - system may be overloaded",
          "transfer"
        );
      }
    } else {
      consecutiveLongTicks = 0;
      if (typeof setConsecutiveLongTicks === "function") {
        setConsecutiveLongTicks(consecutiveLongTicks);
      }
    }

    if (tickTotalTime > 150) {
      if (typeof setEmergencyDisableTicks === "function") {
        setEmergencyDisableTicks(60);
      }

      sendDiagnosticMessage(
        "§c[PERF] EMERGENCY: Tick took " +
          tickTotalTime +
          "ms (>150ms) - Transfer disabled for 60 ticks",
        "transfer"
      );

      try {
        const players = world && typeof world.getAllPlayers === "function" ? world.getAllPlayers() : [];
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(
              "§c[PERF] CRITICAL: Transfer system disabled for 60 ticks due to " +
                tickTotalTime +
                "ms tick time"
            );
            break;
          }
        }
      } catch {}
    }

    if (tickTotalTime < 80) {
      consecutiveLongTicks = 0;
      if (typeof setConsecutiveLongTicks === "function") {
        setConsecutiveLongTicks(consecutiveLongTicks);
      }
    }

    return {
      ...ok(),
      persistTime,
      inflightSaveTime,
      levelsSaveTime,
      outputLevelsSaveTime,
      prismLevelsSaveTime,
      tickTotalTime,
    };
  };
}


















