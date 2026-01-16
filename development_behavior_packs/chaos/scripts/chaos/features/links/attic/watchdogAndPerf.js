// scripts/chaos/features/links/transfer/runtime/phases/watchdogAndPerf.js

export function createWatchdogAndPerfPhase(deps) {
  return {
    name: "watchdogAndPerf",
    run(ctx) {
      return { ok: true };
    },
  };
}

