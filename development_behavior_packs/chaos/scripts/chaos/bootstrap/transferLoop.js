// scripts/chaos/bootstrap/transferLoop.js
import { createTransferPathfinder } from "../features/links/transfer/pathfinding/pathfinder.js";
import { getNetworkStamp } from "../features/links/shared/networkStamp.js";
// Controller import enabled for testing
import { createNetworkTransferController } from "../features/links/transfer/runtime/controller.js";
import { setCacheInvalidationFn } from "../features/links/beam/events.js";

// Module-level storage for cache invalidation function (optional dependency)
let cacheInvalidationFn = null;

/**
 * Get the cache invalidation function if available.
 * Returns null if transfer controller hasn't been created yet.
 */
export function getCacheInvalidationFn() {
  return cacheInvalidationFn;
}

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    FX,
  } = ctx;

  let transferStarted = false;

  function sendChat(msg) {
    try {
      if (!world || typeof world !== "object") return;
      if (typeof world.getAllPlayers !== "function") return;
      
      const msgStr = String(msg || "");
      if (!msgStr) return;
      
      let players;
      try {
        players = world.getAllPlayers();
      } catch {
        return;
      }
      
      if (!players) return;
      
      // Handle both iterable and array-like
      try {
        if (typeof players[Symbol.iterator] === "function") {
          // Iterable (standard case)
          for (const player of players) {
            try {
              if (player && typeof player === "object" && typeof player.sendMessage === "function") {
                player.sendMessage(msgStr);
              }
            } catch {}
          }
        } else if (typeof players.length === "number") {
          // Array-like (fallback)
          for (let i = 0; i < players.length; i++) {
            try {
              const player = players[i];
              if (player && typeof player === "object" && typeof player.sendMessage === "function") {
                player.sendMessage(msgStr);
              }
            } catch {}
          }
        }
      } catch {}
    } catch {
      // ignore all errors
    }
  }

  // EARLY DEBUG: Verify startTransferLoop was called
  try {
    sendChat("§a[TransferLoop] startTransferLoop() function called");
  } catch {}

  // Start transfer loop immediately (no longer waiting for pairs - beam simulation handles connections)
  // Use runTimeout first to ensure world is ready, then set up interval
  system.runTimeout(() => {
    try {
      sendChat("§b[TransferLoop] Setting up transfer loop interval...");
      
      system.runInterval(() => {
        if (transferStarted) return;

        transferStarted = true;
        
        // INIT DEBUG: Transfer loop started
        sendChat("§b[TransferLoop] Starting transfer loop initialization...");

        try {
          // INIT DEBUG: Creating pathfinder
          sendChat("§b[TransferLoop] Step 1/3: Creating pathfinder...");
          
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
          
          // INIT DEBUG: Pathfinder created
          sendChat("§a[TransferLoop] ✓ Pathfinder created");

          // INIT DEBUG: Controller creation
          sendChat("§b[TransferLoop] Step 2/3: Creating controller...");
          
          // Create controller with required dependencies
          let controller;
          try {
            controller = createNetworkTransferController(
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
          } catch (err) {
            const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
            sendChat("§c[TransferLoop] ✗ Controller creation FAILED: " + errMsg);
            if (err && err.stack) {
              const stack = String(err.stack).substring(0, 300);
              sendChat("§c[TransferLoop] Stack: " + stack);
            }
            throw err;
          }
          
          // INIT DEBUG: Controller created
          if (controller) {
            sendChat("§a[TransferLoop] ✓ Controller created");
          } else {
            sendChat("§c[TransferLoop] ✗ Controller is null!");
            return;
          }

          // INIT DEBUG: Setting up cache invalidation
          sendChat("§b[TransferLoop] Step 3/3: Setting up cache invalidation...");

          // Extract and store cache invalidation function from controller
          if (controller && typeof controller.getCacheManager === "function") {
            try {
              const cacheManager = controller.getCacheManager();
              if (cacheManager && typeof cacheManager.invalidateCachesForBlockChange === "function") {
                cacheInvalidationFn = cacheManager.invalidateCachesForBlockChange.bind(cacheManager);
                // Update beam events system with the cache invalidation function
                if (typeof setCacheInvalidationFn === "function") {
                  setCacheInvalidationFn(cacheInvalidationFn);
                }
                sendChat("§a[TransferLoop] ✓ Cache invalidation set up");
              } else {
                sendChat("§e[TransferLoop] Cache invalidation not available (optional)");
              }
            } catch (err) {
              const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
              sendChat("§e[TransferLoop] Cache invalidation error: " + errMsg);
            }
          }

          // INIT DEBUG: Starting controller
          sendChat("§b[TransferLoop] Starting controller (calling controller.start())...");

          // Start the controller
          if (controller && typeof controller.start === "function") {
            controller.start();
            sendChat("§a[TransferLoop] ✓ Controller.start() called successfully");
          } else {
            sendChat("§c[TransferLoop] ✗ Controller.start() is not a function!");
          }
          
          sendChat("§a[TransferLoop] ✓ Transfer loop setup completed");
        } catch (err) {
          try {
            const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
            sendChat("§c[TransferLoop] ✗ Error: " + errMsg);
            if (err && err.stack) {
              const stack = String(err.stack).substring(0, 300);
              sendChat("§c[TransferLoop] Stack: " + stack);
            }
          } catch {}
        }
      }, 1);
    } catch (err) {
      try {
        const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
        sendChat("§c[TransferLoop] ✗ Error setting up interval: " + errMsg);
      } catch {}
    }
  }, 5); // Small delay to ensure world is ready
}
