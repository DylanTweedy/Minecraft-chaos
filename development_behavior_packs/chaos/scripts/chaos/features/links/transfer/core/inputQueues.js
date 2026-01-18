// scripts/chaos/features/links/transfer/core/inputQueues.js
import { parseKey } from "../keys.js";
/**
 * Input Queue Manager
 * 
 * Queues entire item stacks from source prisms when found.
 * One queue entry per item type per prism.
 * Continues transfers from queue without rescanning.
 */

/**
 * Creates an input queue manager
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Input queue manager
 */
export function createInputQueuesManager(cfg, deps) {
  const { world, getContainerKey, getContainerKeyFromInfo, isPathBlock } = deps;

  // Map<prismKey, Array<InputQueueEntry>> - One entry per item type
  const inputQueues = new Map();

  // Default validation interval (ticks)
  const DEFAULT_VALIDATION_INTERVAL = 20;

  /**
   * Input queue entry structure
   * @typedef {Object} InputQueueEntry
   * @property {string} prismKey - Prism key
   * @property {string} itemTypeId - Item type ID
   * @property {number} slot - Slot number in container
   * @property {string} containerKey - Container key
   * @property {number} totalAmount - Original stack size
   * @property {number} remainingAmount - Amount left to transfer
   * @property {string|null} lastDestination - Last destination used (for route reuse)
 * @property {Array|null} cachedRoute - Cached path (if available)
 * @property {number} lastValidatedTick - Last tick this entry was validated
 * @property {number} validationInterval - How often to validate (default: 20 ticks)
  * @property {any|null} metadata - Optional metadata provided during enqueue
   */

  /**
   * Enqueue input stacks for a prism (ALL item types found)
   * @param {string} prismKey - Prism key
   * @param {Array} itemSources - Array of { container, slot, stack, inventoryIndex }
   * @param {Map} routesByType - Optional: Map<typeId, route> for cached routes
   * @param {Map} entryMetaByType - Optional metadata added to each queue entry per item type
   */
  function enqueueInputStacks(
    prismKey,
    itemSources,
    routesByType = null,
    entryMetaByType = null
  ) {
    if (!prismKey || !Array.isArray(itemSources) || itemSources.length === 0) return;

    const queue = inputQueues.get(prismKey) || [];
    // Track existing entries by type AND container to allow re-queuing if items remain after processing
    const existingEntriesByType = new Map(); // typeId -> entry (for updating remainingAmount)
    for (const entry of queue) {
      if (!existingEntriesByType.has(entry.itemTypeId)) {
        existingEntriesByType.set(entry.itemTypeId, entry);
      }
    }

    // Queue ALL item types (update existing entries if same type, or create new entry)
    for (const itemSource of itemSources) {
      if (!itemSource || !itemSource.stack || !itemSource.container || itemSource.slot === undefined) continue;
      
      const { container, slot, stack } = itemSource;
      if (!stack || !stack.typeId || stack.amount <= 0) continue;

      const containerKey = getContainerKeyFromInfo({
        container,
        entity: itemSource.entity,
        block: itemSource.block,
        dim: itemSource.dim,
      });
      if (!containerKey) continue;

      // Check if entry already exists for this type and container/slot
      const existingEntry = existingEntriesByType.get(stack.typeId);
      if (existingEntry) {
        // Entry exists for this type - update if same container/slot, otherwise skip (avoid duplicates)
      if (existingEntry.containerKey === containerKey && existingEntry.slot === slot) {
        // Same container and slot - update remaining amount to reflect current stack size
        existingEntry.remainingAmount = stack.amount;
        existingEntry.totalAmount = stack.amount;
        // Update route if provided
        if (routesByType && routesByType.has(stack.typeId)) {
          existingEntry.cachedRoute = routesByType.get(stack.typeId);
        }
        if (entryMetaByType && entryMetaByType.has(stack.typeId)) {
          existingEntry.metadata = entryMetaByType.get(stack.typeId);
        }
      }
        // Skip creating duplicate entry (but existing entry was updated above)
        continue;
      }

      const entry = {
        prismKey,
        itemTypeId: stack.typeId,
        slot,
        containerKey,
        totalAmount: stack.amount,
        remainingAmount: stack.amount,
        lastDestination: null,
        cachedRoute: routesByType?.get(stack.typeId) || null,
        lastValidatedTick: 0,
        validationInterval: DEFAULT_VALIDATION_INTERVAL,
        metadata: entryMetaByType?.get(stack.typeId) || null,
      };

      queue.push(entry);
    }

    if (queue.length > 0) {
      inputQueues.set(prismKey, queue);
    }
  }

  /**
   * Get all queue entries for a prism
   * @param {string} prismKey - Prism key
   * @returns {Array<InputQueueEntry>} Queue entries
   */
  function getQueuesForPrism(prismKey) {
    if (!prismKey) return [];
    return inputQueues.get(prismKey) || [];
  }

  /**
   * Check if prism has any active queues
   * @param {string} prismKey - Prism key
   * @returns {boolean} True if has queues
   */
  function hasQueueForPrism(prismKey) {
    if (!prismKey) return false;
    const queue = inputQueues.get(prismKey);
    return queue && queue.length > 0;
  }

  /**
   * Get total queue size across all prisms
   * @returns {number} Total number of queue entries
   */
  function getTotalQueueSize() {
    let total = 0;
    for (const queue of inputQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get queue info for linkVision display
   * @param {string} prismKey - Prism key
   * @returns {Object|null} Queue info: { count: number, items: Array<{typeId, remaining}> }
   */
  function getQueueInfo(prismKey) {
    if (!prismKey) return null;
    const queue = inputQueues.get(prismKey);
    if (!queue || queue.length === 0) return null;

    const items = queue.map(entry => ({
      typeId: entry.itemTypeId,
      remaining: entry.remainingAmount,
    }));

    return {
      count: queue.length,
      items,
    };
  }

  /**
   * Validate a queue entry (check if slot still has items, route still valid)
   * @param {InputQueueEntry} queueEntry - Queue entry to validate
   * @param {number} nowTick - Current tick
   * @returns {boolean} True if entry is still valid
   */
  function validateInputQueue(queueEntry, nowTick) {
    if (!queueEntry) return false;

    // Check if validation needed
    if ((nowTick - queueEntry.lastValidatedTick) < queueEntry.validationInterval) {
      return true; // Skip validation if too recent
    }

    // Quick check: verify container still exists
    try {
      const parsed = parseKey(queueEntry.containerKey);
      if (!parsed) return false;
      
      const dim = world.getDimension(parsed.dimId);
      if (!dim) return false;

      const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
      if (!block) return false;

      // Check if container still has inventory
      const container = block.getComponent("minecraft:inventory")?.container;
      if (!container) {
        // Try entity container
        const entities = dim.getEntitiesAtBlockLocation({ x: parsed.x, y: parsed.y, z: parsed.z });
        let foundContainer = false;
        for (const entity of entities) {
          const entityContainer = entity.getComponent("minecraft:inventory")?.container;
          if (entityContainer) {
            foundContainer = true;
            break;
          }
        }
        if (!foundContainer) return false;
      }

      // Check slot still has items (quick check - don't read full stack)
      if (container) {
        const item = container.getItem(queueEntry.slot);
        if (!item || item.typeId !== queueEntry.itemTypeId || item.amount <= 0) {
          return false; // Slot doesn't have items anymore
        }
        // Update remaining amount from actual stack
        queueEntry.remainingAmount = Math.min(queueEntry.remainingAmount, item.amount);
      }

      // Validate route if exists
      if (queueEntry.cachedRoute && queueEntry.cachedRoute.length > 0) {
        if (!validateRoute(queueEntry, nowTick)) {
          // Route invalid - clear it (will be re-found)
          queueEntry.cachedRoute = null;
        }
      }

      queueEntry.lastValidatedTick = nowTick;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Validate route (check if all blocks in route still exist)
   * @param {InputQueueEntry} queueEntry - Queue entry with route
   * @param {number} nowTick - Current tick (not used but kept for consistency)
   * @returns {boolean} True if route is valid
   */
  function validateRoute(queueEntry, nowTick) {
    if (!queueEntry || !queueEntry.cachedRoute || !Array.isArray(queueEntry.cachedRoute) || queueEntry.cachedRoute.length === 0) {
      return false; // No route to validate
    }

    try {
      for (const blockPos of queueEntry.cachedRoute) {
        if (!blockPos || typeof blockPos.dimId !== "string") return false;

        const dim = world.getDimension(blockPos.dimId);
        if (!dim) return false; // Dimension doesn't exist

        const block = dim.getBlock({ x: blockPos.x, y: blockPos.y, z: blockPos.z });
        if (!block) return false; // Block doesn't exist

        // Check if block is still a valid path block
        if (typeof isPathBlock === "function" && !isPathBlock(block)) {
          return false; // Block is no longer a valid path block
        }
      }

      return true; // Route is valid
    } catch (e) {
      return false;
    }
  }

  /**
   * Invalidate input queue for a prism (clear all entries)
   * @param {string} prismKey - Prism key
   * @param {string|null} containerKey - Optional: specific container key (clear entries for that container only)
   */
  function invalidateInputQueue(prismKey, containerKey = null) {
    if (!prismKey) return;

    if (containerKey) {
      // Clear entries for specific container only
      const queue = inputQueues.get(prismKey);
      if (queue) {
        const filtered = queue.filter(entry => entry.containerKey !== containerKey);
        if (filtered.length === 0) {
          inputQueues.delete(prismKey);
        } else {
          inputQueues.set(prismKey, filtered);
        }
      }
    } else {
      // Clear all entries for prism
      inputQueues.delete(prismKey);
    }
  }

  /**
   * Get next queue entry to process (for filtered prisms: extract non-filtered items, FIFO)
   * @param {string} prismKey - Prism key
   * @param {Set|null} filterSet - Optional: filter set (for filtered prisms, extract items NOT in filter)
   * @returns {InputQueueEntry|null} Next entry to process
   */
  function getNextQueueEntry(prismKey, filterSet = null) {
    const queue = inputQueues.get(prismKey);
    if (!queue || queue.length === 0) return null;

    // For filtered prisms, extract non-filtered items (items NOT in filter)
    // Filtered items should never be in the queue (they're skipped during queue creation)
    // But if they somehow are, skip them here
    if (filterSet && filterSet.size > 0) {
      // Find non-filtered items (items NOT in the filter - these are what we want to extract)
      const nonFiltered = queue.filter(entry => !filterSet.has(entry.itemTypeId));
      if (nonFiltered.length > 0) {
        // Return first non-filtered item (FIFO)
        return nonFiltered[0];
      }
      // If only filtered items in queue (shouldn't happen, but handle it), return null
      return null;
    }

    // No filter - return first item (FIFO)
    return queue[0] || null;
  }

  /**
   * Update queue entry after transfer (reduce remaining amount or remove if depleted)
   * @param {string} prismKey - Prism key
   * @param {string} itemTypeId - Item type ID
   * @param {number} transferredAmount - Amount transferred
   */
  function updateQueueEntry(prismKey, itemTypeId, transferredAmount) {
    if (!prismKey || !itemTypeId || transferredAmount <= 0) return;

    const queue = inputQueues.get(prismKey);
    if (!queue || queue.length === 0) return;

    const entryIndex = queue.findIndex(entry => entry.itemTypeId === itemTypeId);
    if (entryIndex === -1) return;

    const entry = queue[entryIndex];
    entry.remainingAmount = Math.max(0, entry.remainingAmount - transferredAmount);

    // Remove entry if depleted
    if (entry.remainingAmount <= 0) {
      queue.splice(entryIndex, 1);
      if (queue.length === 0) {
        inputQueues.delete(prismKey);
      }
    }
  }

  /**
   * Set cached route for a queue entry
   * @param {string} prismKey - Prism key
   * @param {string} itemTypeId - Item type ID
   * @param {Array} route - Route path
   */
  function setCachedRoute(prismKey, itemTypeId, route) {
    if (!prismKey || !itemTypeId) return;

    const queue = inputQueues.get(prismKey);
    if (!queue || queue.length === 0) return;

    const entry = queue.find(e => e.itemTypeId === itemTypeId);
    if (entry) {
      entry.cachedRoute = route;
    }
  }

  /**
   * Parse container key (helper function)
   * @param {string} containerKey - Container key (format: "dimId|x,y,z")
   * @returns {Object|null} Parsed key: { dimId, x, y, z }
   */
  function parseKey(containerKey) {
    if (!containerKey || typeof containerKey !== "string") return null;
    try {
      const bar = containerKey.indexOf("|");
      if (bar === -1) return null;

      const dimId = containerKey.slice(0, bar);
      const rest = containerKey.slice(bar + 1);
      const parts = rest.split(",");
      if (parts.length !== 3) return null;

      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

      return { dimId, x, y, z };
    } catch (e) {
      return null;
    }
  }

  return {
    enqueueInputStacks,
    getQueuesForPrism,
    hasQueueForPrism,
    getTotalQueueSize,
    getQueueInfo,
    validateInputQueue,
    validateRoute,
    invalidateInputQueue,
    getNextQueueEntry,
    updateQueueEntry,
    setCachedRoute,
  };
}
