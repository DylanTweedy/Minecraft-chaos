// scripts/chaos/features/links/transfer/runtime/phases/persistAndReport.js

import { ok, phaseStep } from "../../util/result.js";

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
    shouldSave,
    dirtyKeys,
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
    sendInitMessage,
    debugEnabled,
    debugState,
    debugInterval,
    getLastDebugTick,
    setLastDebugTick,
    inputQueuesManager,
    getQueueState,
    getNowTick,
    noteGlobalQueues,
    noteGlobalInflight,
    noteGlobalPerf,
    noteWatchdog,
    getLastTickEndTime,
    setLastTickEndTime,
    getConsecutiveLongTicks,
    setConsecutiveLongTicks,
    setEmergencyDisableTicks,
    prismRegistry,
    linkGraph,
  } = deps || {};

  const DIRTY = dirtyKeys || {
    INF: "inflight",
    INF_STEP: "inflightStep",
    LEVELS: "levels",
    OUT: "outputLevels",
    PRISM: "prismLevels",
  };

  let lastInflightSkipLogTick = 0;

  function persistCountsIfNeeded(
    key,
    getDirty,
    getLastSaveTick,
    setDirty,
    setLastSaveTick,
    countsMap,
    saveFn,
    minInterval = 200
  ) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const lastSaveTick = typeof getLastSaveTick === "function" ? getLastSaveTick() : 0;
    if (typeof shouldSave === "function") {
      if (!shouldSave(key, nowTick, lastSaveTick, minInterval)) return;
    } else if (!getDirty() && (nowTick - lastSaveTick) < minInterval) {
      return;
    }

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
    if (typeof shouldSave === "function") {
      const key = inflightStepDirty ? DIRTY.INF_STEP : DIRTY.INF;
      if (!shouldSave(key, nowTick, lastSave, interval)) {
        const logInterval = Math.max(20, Number(debugInterval) || 0) || 60;
        if (debugEnabled && (nowTick - lastInflightSkipLogTick) >= logInterval) {
          lastInflightSkipLogTick = nowTick;
        }
        return;
      }
    } else if ((nowTick - lastSave) < interval) {
      return;
    }

    const estimatedSize = inflight.length * 800;
    if (estimatedSize > 400000) {
      if (typeof noteWatchdog === "function") {
        noteWatchdog(
          "WARN",
          "Inflight too large (" + inflight.length + ", ~" + Math.round(estimatedSize / 1024) + "KB)",
          nowTick
        );
      }

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
      DIRTY.LEVELS,
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
      DIRTY.OUT,
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
      DIRTY.PRISM,
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
    if (debugState.phaseMs) debugState.phaseMs = Object.create(null);
    if (debugState.phaseRuns) debugState.phaseRuns = Object.create(null);
    if (debugState.phaseLastMs) debugState.phaseLastMs = Object.create(null);
  }

  function formatPhaseTiming() {
    const totals = debugState.phaseMs || {};
    const runs = debugState.phaseRuns || {};
    const entries = Object.entries(totals).map(([name, total]) => {
      const count = runs[name] || 0;
      const avg = count > 0 ? (total / count) : 0;
      return [name, avg];
    }).filter(([, avg]) => Number.isFinite(avg) && avg > 0);
    if (!entries.length) return "";

    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 4);
    const parts = top.map(([name, avg]) => name + "=" + avg.toFixed(1) + "ms");
    return " | Phases: " + parts.join(", ");
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

      if (typeof noteGlobalQueues === "function") {
        noteGlobalQueues({
          queues: inputQueueSize,
          queuedContainers,
          queuedItems,
        });
      }
      if (typeof noteGlobalInflight === "function") {
        noteGlobalInflight(inflight ? inflight.length : 0);
      }
      resetDebugState();
    } catch (err) {
      if (typeof noteWatchdog === "function") {
        noteWatchdog(
          "ERROR",
          "Transfer stats error: " + (err?.message || String(err)),
          nowTick
        );
      }
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
    let registrySaveTime = 0;
    let linkSaveTime = 0;

    if (!shouldSkipSaves) {
      const inflightSaveStart = Date.now();
      persistInflightIfNeeded();
      inflightSaveTime = Date.now() - inflightSaveStart;
      if (typeof noteGlobalPerf === "function") {
        noteGlobalPerf("persist", inflightSaveTime);
      }

      const levelsSaveStart = Date.now();
      persistLevelsIfNeeded();
      levelsSaveTime = Date.now() - levelsSaveStart;
      if (typeof noteGlobalPerf === "function") {
        noteGlobalPerf("persist", levelsSaveTime);
      }

      const outputLevelsSaveStart = Date.now();
      persistOutputLevelsIfNeeded();
      outputLevelsSaveTime = Date.now() - outputLevelsSaveStart;
      if (typeof noteGlobalPerf === "function") {
        noteGlobalPerf("persist", outputLevelsSaveTime);
      }

      const prismLevelsSaveStart = Date.now();
      persistPrismLevelsIfNeeded();
      prismLevelsSaveTime = Date.now() - prismLevelsSaveStart;
      if (typeof noteGlobalPerf === "function") {
        noteGlobalPerf("persist", prismLevelsSaveTime);
      }

      const registrySaveStart = Date.now();
      if (prismRegistry && typeof prismRegistry.persistIfDirty === "function") {
        prismRegistry.persistIfDirty();
      }
      registrySaveTime = Date.now() - registrySaveStart;

      const linkSaveStart = Date.now();
      if (linkGraph && typeof linkGraph.persistIfDirty === "function") {
        linkGraph.persistIfDirty();
      }
      linkSaveTime = Date.now() - linkSaveStart;
    } else {
      if (typeof noteWatchdog === "function") {
        noteWatchdog("WARN", "Skipping saves (tick " + timeBeforePersist + "ms)", nowTick);
      }
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

    if (typeof noteGlobalPerf === "function") {
      noteGlobalPerf("persist", persistTime);
    }

    if (persistTime > 100 && typeof noteWatchdog === "function") {
      noteWatchdog("WARN", "Persistence " + persistTime + "ms", nowTick);
    }

    const tickTotalTime = Date.now() - tickStart;
    if (typeof setLastTickEndTime === "function") {
      setLastTickEndTime(Date.now());
    }

    if (typeof noteGlobalPerf === "function") {
      noteGlobalPerf("tick", tickTotalTime);
    }

    if (tickTotalTime > 100) {
      consecutiveLongTicks++;
      if (typeof setConsecutiveLongTicks === "function") {
        setConsecutiveLongTicks(consecutiveLongTicks);
      }

      if (typeof noteWatchdog === "function") {
        noteWatchdog(
          "WARN",
          "Tick " + tickTotalTime + "ms (consecutive " + consecutiveLongTicks + ")",
          nowTick
        );
      }

      if (consecutiveLongTicks > 3 && typeof noteWatchdog === "function") {
        noteWatchdog(
          "CRIT",
          consecutiveLongTicks + " consecutive ticks >100ms",
          nowTick
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

      if (typeof noteWatchdog === "function") {
        noteWatchdog(
          "EMERGENCY",
          "Tick " + tickTotalTime + "ms (transfers paused)",
          nowTick
        );
      }
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




