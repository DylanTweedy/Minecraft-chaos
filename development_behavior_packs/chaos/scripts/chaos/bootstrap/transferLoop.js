// scripts/chaos/bootstrap/transferLoop.js
import { createTransferController } from "../features/links/transfer.js";

export function startTransferLoop(ctx) {
  const {
    world,
    system,
    isPairsReady,
    getPairsMap,
    fxTransferItem,
    FX,
  } = ctx;

  let transferStarted = false;

  function parseKey(key) {
    try {
      if (typeof key !== "string") return null;
      const pipe = key.indexOf("|");
      if (pipe <= 0) return null;

      const dimId = key.slice(0, pipe);
      const rest = key.slice(pipe + 1);
      const parts = rest.split(",");
      if (parts.length !== 3) return null;

      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

      return { dimId, x: x | 0, y: y | 0, z: z | 0 };
    } catch {
      return null;
    }
  }

  // Start transfer loop after ready
  system.runInterval(() => {
    if (transferStarted) return;
    if (!isPairsReady()) return;

    transferStarted = true;

    try {
      const controller = createTransferController(
        {
          world,
          system,
          isPairsReady,
          getPairsMap,
          parseKey,
          fxTransfer: (fromBlock, toBlock, itemTypeId) =>
            fxTransferItem(fromBlock, toBlock, itemTypeId, FX),
        },
        {
          maxTransfersPerTick: 4,
          perInputIntervalTicks: 10,
          maxAltOutputTries: 2,
        }
      );
      controller.start();
    } catch {
      // never break load
    }
  }, 1);
}
