// scripts/chaos/features/links/transfer/core/queues.js
import { isPrismBlock, CRYSTALLIZER_ID } from "../config.js";
import { tryInsertAmountForContainer, isFurnaceBlock } from "../inventory/inventory.js";
import { releaseContainerSlot } from "../inventory/reservations.js";

/**
 * Creates a queue manager for transfer queue operations
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Queue manager with queue methods
 */
export function createQueuesManager(cfg, deps) {
  const { cacheManager, resolveBlockInfo, dropItemAt, noteOutputTransfer } = deps;

  // Queue state - maintained by controller but managed by this module
  const state = {
    queueByContainer: new Map(),
    fullContainers: new Set(),
    fullCursor: 0,
    queueCursor: 0,
  };

  /**
   * Initialize with existing queue state (for persistence)
   * @param {Map} queueByContainer - Existing queue map
   * @param {Set} fullContainers - Existing full containers set
   */
  function initializeState(queueByContainer, fullContainers) {
    if (queueByContainer instanceof Map) {
      state.queueByContainer = queueByContainer;
    }
    if (fullContainers instanceof Set) {
      state.fullContainers = fullContainers;
    }
  }

  /**
   * Get queue state for external access
   * @returns {Object} State object with queueByContainer and fullContainers
   */
  function getState() {
    return {
      queueByContainer: state.queueByContainer,
      fullContainers: state.fullContainers,
    };
  }

  /**
   * Enqueue a pending transfer for a container
   * @param {string} containerKey - Container key
   * @param {string} itemTypeId - Item type ID
   * @param {number} amount - Item amount
   * @param {string} outputKey - Output key (optional)
   * @param {string} reservedTypeId - Reserved type ID
   */
  function enqueuePendingForContainer(containerKey, itemTypeId, amount, outputKey, reservedTypeId) {
    if (!containerKey || !itemTypeId || amount <= 0) return;
    let queue = state.queueByContainer.get(containerKey);
    if (!queue) {
      queue = [];
      state.queueByContainer.set(containerKey, queue);
    }
    queue.push({ itemTypeId, amount, outputKey, reservedTypeId: reservedTypeId || itemTypeId });
    const info = cacheManager.resolveContainerInfoCached(containerKey);
    if (!isFurnaceBlock(info?.block)) state.fullContainers.add(containerKey);
  }

  /**
   * Resolve container info (wrapper for cache manager)
   * @param {string} containerKey - Container key
   * @returns {Object|null} Container info object
   */
  function resolveContainerInfo(containerKey) {
    return cacheManager.resolveContainerInfoCached(containerKey);
  }

  /**
   * Process output queues - attempt to insert queued items into containers
   */
  function tickOutputQueues() {
    let budget = Math.max(0, cfg.maxQueuedInsertsPerTick | 0);
    if (budget <= 0 || state.queueByContainer.size === 0) return;

    const keys = Array.from(state.queueByContainer.keys());
    while (budget > 0 && keys.length > 0) {
      if (state.queueCursor >= keys.length) state.queueCursor = 0;
      const containerKey = keys[state.queueCursor++];
      const queue = state.queueByContainer.get(containerKey);
      if (!queue || queue.length === 0) {
        state.queueByContainer.delete(containerKey);
        state.fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        while (queue.length > 0) {
          const job = queue.shift();
          const outInfo = job?.outputKey ? resolveBlockInfo(job.outputKey) : null;
          if (outInfo?.dim && outInfo?.block) {
            dropItemAt(outInfo.dim, outInfo.block.location, job.itemTypeId, job.amount);
          } else if (info?.dim) {
            dropItemAt(info.dim, info.pos, job.itemTypeId, job.amount);
          }
          releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
        }
        state.queueByContainer.delete(containerKey);
        state.fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const job = queue[0];
      if (!job) {
        queue.shift();
        budget--;
        continue;
      }

      if (tryInsertAmountForContainer(info.container, info.block || null, job.itemTypeId, job.amount)) {
        queue.shift();
        releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
        const outInfo = job.outputKey ? resolveBlockInfo(job.outputKey) : null;
        if (outInfo?.block && (isPrismBlock(outInfo.block) || outInfo.block.typeId === CRYSTALLIZER_ID)) {
          // Note output transfer (for crystallizers and legacy output tracking)
          noteOutputTransfer(job.outputKey, outInfo.block);
        }
        if (queue.length === 0) {
          state.queueByContainer.delete(containerKey);
          state.fullContainers.delete(containerKey);
        }
      } else if (!isFurnaceBlock(info.block)) {
        state.fullContainers.add(containerKey);
      }
      budget--;
    }
  }

  /**
   * Process full containers - check if containers have capacity again
   */
  function tickFullContainers() {
    const total = state.fullContainers.size;
    if (total === 0) return;
    let budget = Math.max(0, cfg.maxFullChecksPerTick | 0);
    if (budget <= 0) return;

    const keys = Array.from(state.fullContainers);
    while (budget-- > 0 && keys.length > 0) {
      if (state.fullCursor >= keys.length) state.fullCursor = 0;
      const containerKey = keys[state.fullCursor++];
      if (state.queueByContainer.has(containerKey)) continue;

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        state.fullContainers.delete(containerKey);
        continue;
      }
      const capacity = cacheManager.getContainerCapacityCached(containerKey, info.container);
      if (capacity > 0) state.fullContainers.delete(containerKey);
    }
  }

  return {
    initializeState,
    getState,
    enqueuePendingForContainer,
    resolveContainerInfo,
    tickOutputQueues,
    tickFullContainers,
  };
}
