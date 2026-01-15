// scripts/chaos/features/links/transfer/runtime/hybrid/scheduler.js

export function createHybridScheduler(cfg = {}) {
  const caps = {
    maxOrbsActiveTotal: Math.max(1, Number(cfg?.hybridMaxOrbsActiveTotal) || 200),
    maxNewTransfersPerTick: Math.max(1, Number(cfg?.hybridMaxNewTransfersPerTick) || 20),
    maxArrivalsProcessedPerTick: Math.max(1, Number(cfg?.hybridMaxArrivalsProcessedPerTick) || 40),
    maxPathfindsPerTick: Math.max(1, Number(cfg?.hybridMaxPathfindsPerTick) || 3),
  };

  const usage = {
    transfers: 0,
    arrivals: 0,
    pathfinds: 0,
  };

  function beginTick() {
    usage.transfers = 0;
    usage.arrivals = 0;
    usage.pathfinds = 0;
    // TODO: replace soft caps with time-budgeting later
  }

  function canSpawnNewTransfer(inflightLen = 0) {
    return (
      inflightLen < caps.maxOrbsActiveTotal &&
      usage.transfers < caps.maxNewTransfersPerTick
    );
  }

  function useNewTransfer() {
    usage.transfers++;
  }

  function canProcessArrival() {
    return usage.arrivals < caps.maxArrivalsProcessedPerTick;
  }

  function useArrival() {
    usage.arrivals++;
  }

  function canPathfind() {
    return usage.pathfinds < caps.maxPathfindsPerTick;
  }

  function usePathfind() {
    usage.pathfinds++;
  }

  function getCaps() {
    return { ...caps };
  }

  function getUsed() {
    return { ...usage };
  }

  return {
    beginTick,
    canSpawnNewTransfer,
    useNewTransfer,
    canProcessArrival,
    useArrival,
    canPathfind,
    usePathfind,
    getCaps,
    getUsed,
  };
}
