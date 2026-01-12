// scripts/chaos/features/links/transfer/runtime/phases/updateVirtualState.js

import { ok, phaseStep } from "../helpers/result.js";

export function createUpdateVirtualStatePhase(deps) {
  const handler = createUpdateVirtualStateHandler(deps);

  return {
    name: "updateVirtualState",
    run(ctx) {
      phaseStep(ctx, "updateVirtualState");
      return handler(ctx);
    },
  };
}

function createUpdateVirtualStateHandler(deps) {
  const {
    virtualInventoryManager,
    inputQueuesManager,
    getPrismKeys,
    getQueueState,
    inflight,
    debugEnabled,
    debugState,
    getNowTick,
    sendDiagnosticMessage,
    sendInitMessage,
  } = deps || {};

  return function runUpdateVirtualState() {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const virtualInvStart = Date.now();

    try {
      if (!virtualInventoryManager || typeof virtualInventoryManager.updateState !== "function") {
        // No virtual inventory manager available - nothing to do
      } else {
        const queueState = getQueueState();

        // Get input queues for virtual inventory (if available)
        let inputQueueByPrism = null;

        const prismKeysStart = Date.now();
        if (inputQueuesManager && typeof inputQueuesManager.getQueuesForPrism === "function") {
          inputQueueByPrism = new Map();

          const prismKeys = getPrismKeys();
          for (const prismKey of prismKeys) {
            const queues = inputQueuesManager.getQueuesForPrism(prismKey);
            if (queues && queues.length > 0) {
              inputQueueByPrism.set(prismKey, queues);
            }
          }
        }

        const prismKeysTime = Date.now() - prismKeysStart;
        if (prismKeysTime > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
          sendDiagnosticMessage(
            "[PERF] GetPrismKeys (virtualInv): " + prismKeysTime + "ms",
            "transfer"
          );
        }

        const updateStart = Date.now();
        virtualInventoryManager.updateState(inflight, queueState?.queueByContainer || new Map(), inputQueueByPrism);
        const updateTime = Date.now() - updateStart;

        if (updateTime > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
          sendDiagnosticMessage(
            "[PERF] VirtualInv.updateState: " + updateTime + "ms",
            "transfer"
          );
        }
      }
    } catch (err) {
      const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
      sendInitMessage("¶õc[Flow] Tick " + nowTick + ": ERROR in virtual inventory update: " + errMsg);
    }

    const virtualInvTime = Date.now() - virtualInvStart;
    if (virtualInvTime > 15 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage("[PERF] VirtualInv Total: " + virtualInvTime + "ms", "transfer");
    }

    if (debugEnabled) {
      debugState.msVirtualInv = (debugState.msVirtualInv || 0) + virtualInvTime;
    }

    return { ...ok(), virtualInvTime };
  };
}

