// scripts/chaos/bootstrap/transferLoop.js
// Controller import enabled for testing
import { createNetworkTransferController } from "../features/links/transfer/runtime/controller.js";

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    FX,
    core,
  } = ctx || {};
  const debugApi = core?.debug || {};
  const cursorApi = core?.state?.cursor || {};

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
          // INIT DEBUG: Controller creation
          sendChat("§b[TransferLoop] Step 1/2: Creating controller...");
          
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
                debugEnabled: debugApi.enabled,
                debugInterval: debugApi.interval,
                debugState: debugApi.state,
                getLastDebugTick: debugApi.getLastTick,
                setLastDebugTick: debugApi.setLastTick,
                getCursor: cursorApi.get,
                setCursor: cursorApi.set,
                logError: debugApi.logError,
                handleManagerCreationError: debugApi.handleManagerCreationError,
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
            sendChat("§c[TransferLoop] §- Controller creation FAILED: " + errMsg);
            if (err && err.stack) {
              const stack = String(err.stack).substring(0, 300);
              sendChat("§c[TransferLoop] Stack: " + stack);
            }
            throw err;
          }
          
          // INIT DEBUG: Controller created
          if (controller) {
            sendChat("§a[TransferLoop] ? Controller created");
          } else {
            sendChat("§c[TransferLoop] §- Controller is null!");
            return;
          }

          // INIT DEBUG: Starting controller
          sendChat("§b[TransferLoop] Step 2/2: Starting controller (calling controller.start())...");

          // Start the controller
          if (controller && typeof controller.start === "function") {
            controller.start();
            sendChat("§a[TransferLoop] ? Controller.start() called successfully");
          } else {
            sendChat("§c[TransferLoop] §- Controller.start() is not a function!");
          }
          
          sendChat("§a[TransferLoop] ? Transfer loop setup completed");
        } catch (err) {
          try {
            const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
            sendChat("§c[TransferLoop] §- Error: " + errMsg);
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
        sendChat("§c[TransferLoop] §- Error setting up interval: " + errMsg);
      } catch {}
    }
  }, 5); // Small delay to ensure world is ready
}
