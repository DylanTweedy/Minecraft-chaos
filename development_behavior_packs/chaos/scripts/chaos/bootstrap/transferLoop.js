// scripts/chaos/bootstrap/transferLoop.js
import { createTransferPathfinder, createNetworkTransferController } from "../features/links/transferSystem.js";
import { getNetworkStamp } from "../features/links/networkStamp.js";

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    isPairsReady,
    FX,
  } = ctx;

  let transferStarted = false;

  // Start transfer loop after ready
  system.runInterval(() => {
    if (transferStarted) return;
    if (!isPairsReady()) return;

    transferStarted = true;

    try {
      const pathfinder = createTransferPathfinder(
        { world, getNetworkStamp },
        {
          cacheTicks: 30,
          cacheTicksWithStamp: 120,
          maxVisitedPerSearch: 120,
          maxOutputOptions: 4,
        }
      );
      const controller = createNetworkTransferController(
        {
          world,
          system,
          findPathForInput: pathfinder.findPathForInput,
          invalidateInput: pathfinder.invalidateInput,
          getPathStats: pathfinder.getAndResetStats,
          getNetworkStamp,
          FX: FX,
        },
        {
          maxTransfersPerTick: 4,
          perInputIntervalTicks: 20,
          orbStepTicks: 60,
          maxOrbFxPerTick: 160,
          debugTransferStats: false,
          maxInputsScannedPerTick: 12,
          maxQueuedInsertsPerTick: 2,
          maxFullChecksPerTick: 2,
        }
      );
      controller.start();
    } catch {
      // never break load
    }
  }, 1);
}
