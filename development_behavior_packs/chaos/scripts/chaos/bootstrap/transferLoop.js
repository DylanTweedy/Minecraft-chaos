// scripts/chaos/bootstrap/transferLoop.js
import {
  createTransferPathfinder,
  createNetworkTransferController,
  getLinksModuleStatus,
} from "../features/links/transferSystem.js";
import { getNetworkStamp } from "../features/links/networkStamp.js";

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    isPairsReady,
    FX,
  } = ctx;

  let transferStarted = false;
  let transferAnnounced = false;

  function sendChat(msg) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (typeof player.sendMessage === "function") player.sendMessage(msg);
      }
    } catch {
      // ignore
    }
  }

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
          debugTransferStats: true,
          debugTransferStatsIntervalTicks: 100,
          maxInputsScannedPerTick: 12,
          maxQueuedInsertsPerTick: 2,
          maxFullChecksPerTick: 2,
        }
      );
      controller.start();
      const status = (typeof getLinksModuleStatus === "function")
        ? getLinksModuleStatus()
        : { loaded: 0, total: 0 };
      if (!transferAnnounced) {
        sendChat(`Chaos Transfer: modules loaded ${status.loaded}/${status.total}.`);
        transferAnnounced = true;
      }
    } catch {
      // never break load
      if (!transferAnnounced) {
        const status = (typeof getLinksModuleStatus === "function")
          ? getLinksModuleStatus()
          : { loaded: 0, total: 0 };
        sendChat(`Chaos Transfer: modules loaded ${status.loaded}/${status.total} (failed to start).`);
        transferAnnounced = true;
      }
    }
  }, 1);
}
