// scripts/chaos/bootstrap/transferLoop.js
import { createTransferPathfinder } from "../features/links/transfer/pathfinding/pathfinder.js";
import { getNetworkStamp } from "../features/links/networkStamp.js";
import { createNetworkTransferController } from "../features/links/transfer/controller.js";

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    isPairsReady,
    FX,
  } = ctx;

  let transferStarted = false;

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
      // Create pathfinder
      const pathfinder = createTransferPathfinder(
        { world, getNetworkStamp },
        {
          cacheTicks: 30,
          cacheTicksWithStamp: 120,
          maxVisitedPerSearch: 120,
          maxOutputOptions: 4,
        }
      );

      // Create controller with required dependencies
      const controller = createNetworkTransferController(
        {
          world,
          system,
          FX,
          getSpeedForInput: (inputKey) => {
            // Simple speed function - can be enhanced later
            return { intervalTicks: 20, amount: 1 };
          },
          findPathForInput: (inputKey, nowTick) => {
            return pathfinder.findPathForInput(inputKey, nowTick);
          },
          invalidateInput: (inputKey) => {
            pathfinder.invalidateInput(inputKey);
          },
          getPathStats: () => {
            return pathfinder.getAndResetStats();
          },
          getNetworkStamp,
        },
        {
          cacheTicks: 30,
          cacheTicksWithStamp: 120,
          maxVisitedPerSearch: 120,
          maxOutputOptions: 4,
        }
      );

      // Start the controller
      if (controller && typeof controller.start === "function") {
        controller.start();
      }
    } catch (err) {
      sendChat(`§cChaos Transfer: Error: ${err?.message || String(err)}`);
      if (err?.stack) {
        const stack = err.stack.substring(0, 300);
        sendChat(`§cStack: ${stack}`);
      }
    }
  }, 1);
}
