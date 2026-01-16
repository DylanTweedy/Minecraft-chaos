// scripts/chaos/features/links/transfer/runtime/phases/processQueues.js

import { ok, phaseStep } from "../../util/result.js";

export function createProcessQueuesPhase(deps) {
  const handler = createProcessQueuesHandler(deps);

  return {
    name: "processQueues",
    run(ctx) {
      phaseStep(ctx, "processQueues");
      return handler(ctx);
    },
  };
}

function createProcessQueuesHandler(deps) {
  const {
    queuesManager,
    inflightProcessorManager,
    inflight,
    fluxFxInflight,
    debugEnabled,
    debugState,
    getNowTick,
    noteWatchdog,
    runTransferPipeline,
    perfLogIfNeeded,
    setInflightDirty,
    setInflightStepDirty,
  } = deps || {};

  const logPerf = typeof perfLogIfNeeded === "function" ? perfLogIfNeeded : () => {};

  return function runProcessQueues() {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const queuesStart = Date.now();

    if (debugEnabled) {
      runTransferPipeline([
        () => {
          const t0 = Date.now();
          queuesManager.tickOutputQueues();
          queuesManager.tickFullContainers();
          const queueTime = Date.now() - t0;

          debugState.msQueues += queueTime;
          logPerf("OutputQueues", queueTime, null);
        },
        () => {
          const t1 = Date.now();
          const result = inflightProcessorManager.tickInFlight(inflight, nowTick);

          if (result) {
            if (typeof setInflightDirty === "function") {
              setInflightDirty(result.inflightDirty || false);
            }
            if (typeof setInflightStepDirty === "function") {
              setInflightStepDirty(result.inflightStepDirty || false);
            }
          }

          const inflightTime = Date.now() - t1;
          debugState.msInflight += inflightTime;

          logPerf("Inflight", inflightTime, String(inflight.length) + " jobs");
        },
        () => {
          const t2 = Date.now();
          inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
          const fluxFxTime = Date.now() - t2;

          debugState.msFluxFx += fluxFxTime;

          logPerf("FluxFX", fluxFxTime, String(fluxFxInflight.length) + " jobs");
        },
      ]);
    } else {
      const queueStart = Date.now();
      queuesManager.tickOutputQueues();
      queuesManager.tickFullContainers();
      const queueTime = Date.now() - queueStart;

      logPerf("OutputQueues", queueTime, null);

      const inflightStart = Date.now();
      const result = inflightProcessorManager.tickInFlight(inflight, nowTick);

      if (result) {
        if (typeof setInflightDirty === "function") {
          setInflightDirty(result.inflightDirty || false);
        }
        if (typeof setInflightStepDirty === "function") {
          setInflightStepDirty(result.inflightStepDirty || false);
        }
      }

      const inflightTime = Date.now() - inflightStart;
      logPerf("Inflight", inflightTime, String(inflight.length) + " jobs");

      const fluxFxStart = Date.now();
      inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
      const fluxFxTime = Date.now() - fluxFxStart;

      logPerf("FluxFX", fluxFxTime, String(fluxFxInflight.length) + " jobs");
    }

    const queuesTotalTime = Date.now() - queuesStart;
    if (queuesTotalTime > 20 || ((nowTick % 200) === 0 && nowTick > 0)) {
      if (typeof noteWatchdog === "function") {
        noteWatchdog("PERF", "Queues+Inflight Total: " + queuesTotalTime + "ms", nowTick);
      }
    }

    return { ...ok(), queuesTotalTime };
  };
}

