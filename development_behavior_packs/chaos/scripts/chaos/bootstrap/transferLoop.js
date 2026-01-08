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
          cacheTicks: 40, // Increased from 30 to cache longer
          cacheTicksWithStamp: 150, // Increased from 120
          maxVisitedPerSearch: 60, // Aggressively reduced from 100 to limit search depth
          maxOutputOptions: 3, // Reduced from 4 to limit pathfinding work
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
          maxTransfersPerTick: 1, // Reduced from 2 - only 1 transfer per tick to minimize scan work
          maxSearchesPerTick: 2, // Reduced from 3 to limit pathfinding overhead
          perInputIntervalTicks: 100, // Increased from 60 to spread scans over many more ticks
          orbStepTicks: 60,
          maxOrbFxPerTick: 160,
          debugTransferStats: true,
          maxPrismsScannedPerTick: 2, // Aggressively reduced from 4 - only scan 2 prisms per tick
          maxInflight: 50, // Reduced from 60 to further lower processing overhead
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
