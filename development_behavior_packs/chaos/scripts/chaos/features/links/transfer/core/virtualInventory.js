// scripts/chaos/features/links/transfer/core/virtualInventory.js
/**
 * Virtual Inventory Manager
 * 
 * Predicts future inventory state by accounting for:
 * - In-flight transfers heading to containers
 * - Queued output items waiting to be inserted
 * - Future: Queued input items waiting to be extracted
 * 
 * This prevents sending items to containers that will be full once pending operations complete.
 */

/**
 * Creates a virtual inventory manager
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Virtual inventory manager
 */
export function createVirtualInventoryManager(cfg, deps) {
  const { getContainerKey } = deps;

  // Track pending items per container
  // Map<containerKey, { byType: Map<typeId, amount>, total: number, lastUpdated: tick }>
  const pendingByContainer = new Map();

  /**
   * Update pending items tracking from in-flight transfers
   * @param {Array} inflight - Array of in-flight transfer jobs
   */
  function updateFromInflight(inflight) {
    // Clear old pending items
    pendingByContainer.clear();

    // Aggregate pending items from in-flight transfers
    for (const job of inflight) {
      if (!job || !job.containerKey || !job.itemTypeId || !job.amount) continue;
      
      const containerKey = job.containerKey;
      let entry = pendingByContainer.get(containerKey);
      if (!entry) {
        entry = { byType: new Map(), total: 0 };
        pendingByContainer.set(containerKey, entry);
      }

      // Track by type for better capacity calculation
      const currentByType = entry.byType.get(job.itemTypeId) || 0;
      entry.byType.set(job.itemTypeId, currentByType + job.amount);
      entry.total += job.amount;
    }
  }

  /**
   * Update pending items tracking from output queues
   * @param {Map} queueByContainer - Map of container queues
   */
  function updateFromOutputQueues(queueByContainer) {
    // Add queued items to pending tracking
    for (const [containerKey, queue] of queueByContainer.entries()) {
      if (!queue || !Array.isArray(queue) || queue.length === 0) continue;

      let entry = pendingByContainer.get(containerKey);
      if (!entry) {
        entry = { byType: new Map(), total: 0 };
        pendingByContainer.set(containerKey, entry);
      }

      // Aggregate all queued items for this container
      for (const job of queue) {
        if (!job || !job.itemTypeId || !job.amount) continue;
        
        const currentByType = entry.byType.get(job.itemTypeId) || 0;
        entry.byType.set(job.itemTypeId, currentByType + job.amount);
        entry.total += job.amount;
      }
    }
  }

  /**
   * Get pending items for a container (for a specific type)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID (optional, if not provided returns total)
   * @returns {number} Pending amount for type, or total if typeId not provided
   */
  function getPendingForContainer(containerKey, typeId = null) {
    if (!containerKey) return 0;
    const entry = pendingByContainer.get(containerKey);
    if (!entry) return 0;
    
    if (typeId) {
      return entry.byType.get(typeId) || 0;
    }
    return entry.total || 0;
  }

  /**
   * Get all pending items for a container
   * @param {string} containerKey - Container key
   * @returns {Object} { byType: Map<typeId, amount>, total: number }
   */
  function getAllPendingForContainer(containerKey) {
    if (!containerKey) return { byType: new Map(), total: 0 };
    const entry = pendingByContainer.get(containerKey);
    if (!entry) return { byType: new Map(), total: 0 };
    return {
      byType: new Map(entry.byType),
      total: entry.total
    };
  }

  /**
   * Calculate virtual capacity for a container
   * Accounts for: current capacity - reservations - pending items
   * @param {string} containerKey - Container key
   * @param {number} currentCapacity - Current available capacity (from cache)
   * @param {number} reserved - Currently reserved capacity
   * @param {string} typeId - Item type ID (optional, for type-specific calculation)
   * @param {number} reservedForType - Reserved capacity for this type (optional)
   * @returns {number} Virtual available capacity
   */
  function getVirtualCapacity(containerKey, currentCapacity, reserved, typeId = null, reservedForType = 0) {
    if (!containerKey || currentCapacity <= 0) return 0;

    // Get pending items for this container
    const pendingForType = typeId ? getPendingForContainer(containerKey, typeId) : getPendingForContainer(containerKey);
    
    // Virtual capacity = current - reserved - pending
    // If type-specific, use type-specific pending and reservations
    if (typeId) {
      const virtual = currentCapacity - reservedForType - pendingForType;
      return Math.max(0, virtual);
    } else {
      const pending = getPendingForContainer(containerKey);
      const virtual = currentCapacity - reserved - pending;
      return Math.max(0, virtual);
    }
  }

  /**
   * Check if container can accept items (virtual capacity check)
   * @param {string} containerKey - Container key
   * @param {number} currentCapacity - Current available capacity
   * @param {number} reserved - Reserved capacity
   * @param {string} typeId - Item type ID
   * @param {number} amount - Amount to check
   * @param {number} reservedForType - Reserved capacity for this type
   * @returns {boolean} True if virtual capacity allows this amount
   */
  function canAcceptVirtual(containerKey, currentCapacity, reserved, typeId, amount, reservedForType = 0) {
    const virtualCapacity = getVirtualCapacity(containerKey, currentCapacity, reserved, typeId, reservedForType);
    return virtualCapacity >= amount;
  }

  /**
   * Add pending items (for future input queue integration)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID
   * @param {number} amount - Amount to add as pending
   */
  function addPending(containerKey, typeId, amount) {
    if (!containerKey || !typeId || amount <= 0) return;
    
    let entry = pendingByContainer.get(containerKey);
    if (!entry) {
      entry = { byType: new Map(), total: 0 };
      pendingByContainer.set(containerKey, entry);
    }

    const current = entry.byType.get(typeId) || 0;
    entry.byType.set(typeId, current + amount);
    entry.total += amount;
  }

  /**
   * Remove pending items (when items are inserted/extracted)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID
   * @param {number} amount - Amount to remove from pending
   */
  function removePending(containerKey, typeId, amount) {
    if (!containerKey || !typeId || amount <= 0) return;
    
    const entry = pendingByContainer.get(containerKey);
    if (!entry) return;

    const current = entry.byType.get(typeId) || 0;
    const next = Math.max(0, current - amount);
    
    if (next === 0) {
      entry.byType.delete(typeId);
    } else {
      entry.byType.set(typeId, next);
    }
    
    entry.total = Math.max(0, entry.total - amount);
    
    // Clean up if empty
    if (entry.total <= 0 && entry.byType.size === 0) {
      pendingByContainer.delete(containerKey);
    }
  }

  /**
   * Update virtual inventory state from all sources
   * Call this each tick before checking capacities
   * @param {Array} inflight - In-flight transfers array
   * @param {Map} queueByContainer - Output queue map
   */
  function updateState(inflight, queueByContainer) {
    // Clear and rebuild from current state
    pendingByContainer.clear();
    updateFromInflight(inflight);
    updateFromOutputQueues(queueByContainer);
    // Future: updateFromInputQueues(inputQueues)
  }

  /**
   * Get container key from inventory info
   * @param {Object} inventoryInfo - Inventory info object
   * @returns {string|null} Container key
   */
  function getInventoryContainerKey(inventoryInfo) {
    if (!inventoryInfo) return null;
    if (inventoryInfo.entity) {
      return getContainerKey(inventoryInfo.entity);
    }
    if (inventoryInfo.block) {
      return getContainerKey(inventoryInfo.block);
    }
    return null;
  }

  return {
    updateState,
    getPendingForContainer,
    getAllPendingForContainer,
    getVirtualCapacity,
    canAcceptVirtual,
    addPending,
    removePending,
    getInventoryContainerKey,
  };
}
