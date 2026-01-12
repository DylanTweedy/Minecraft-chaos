# Pipeline Refactor Plan

1. **Audit existing controller** – document current scan/queue/watchdog/debug blocks and note the exported tick handler so the API surface stays stable.
2. **Build pipeline infrastructure** – create `scripts/chaos/controller/` with `ctx`, `pipeline`, and ordered phase modules while also adding the shared helpers (`pos`, `result`, `reasons`, `candidates`, `prismPos`).
3. **Move logic into phases** – copy the existing controller logic into the new `beginTick`, `refreshPrismRegistry`, `updateVirtualState`, `scanDiscovery`, `processQueues`, `watchdogAndPerf`, `persistAndReport` modules, wiring them through the new context and preserving budgets, caches, and insight gating.
4. **Normalize prism position handling** – centralize `getPrismPos`/`withDim` usage, ensure ctx cache memoization replaces repeated `queuesManager.getState()` calls, and keep all reason strings/counters unchanged.
5. **Hook up controller.js** – make it a thin wrapper that exports the original tick handler while delegating to `controllerTick`.
6. **Verify imports & behavior** – ensure modules have correct relative paths, no circular references, and that debug/performance branches are unchanged.

This plan mirrors the instructed pipeline phases and helper structure so the refactor is systematic and behavior-preserving before work begins.
