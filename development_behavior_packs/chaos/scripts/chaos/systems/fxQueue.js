// scripts/chaos/systems/fxQueue.js
import { system } from "@minecraft/server";
import { configureFxQueue, drainFxQueue } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";

export function startFxQueue() {
  try {
    configureFxQueue(!!FX.fxQueueEnabled, FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick, FX.fxQueueMaxQueued);
  } catch {}
  system.runInterval(() => {
    try {
      configureFxQueue(!!FX.fxQueueEnabled, FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick, FX.fxQueueMaxQueued);
      if (!FX.fxQueueEnabled) return;
      drainFxQueue(FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick);
    } catch {}
  }, 1);
}
