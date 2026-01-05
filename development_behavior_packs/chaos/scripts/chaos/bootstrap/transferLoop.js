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
      const pathfinder = createTransferPathfinder({ world, getNetworkStamp }, { cacheTicks: 10 });
      const controller = createNetworkTransferController(
        {
          world,
          system,
          findPathForInput: pathfinder.findPathForInput,
          invalidateInput: pathfinder.invalidateInput,
          FX: FX,
        },
        {
          maxTransfersPerTick: 4,
          perInputIntervalTicks: 10,
          orbStepTicks: 20,
        }
      );
      controller.start();
    } catch {
      // never break load
    }
  }, 1);
}
