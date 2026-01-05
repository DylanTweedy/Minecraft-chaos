// scripts/chaos/systems/fxQueue.js
import { system } from "@minecraft/server";
import { configureFxQueue, drainFxQueue } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";

export function startFxQueue() {
  configureFxQueue(!!FX.fxQueueEnabled, FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick);
  system.runInterval(() => {
    configureFxQueue(!!FX.fxQueueEnabled, FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick);
    if (!FX.fxQueueEnabled) return;
    drainFxQueue(FX.fxQueueMaxPerTick ?? FX.maxParticlesPerTick);
  }, 1);
}
