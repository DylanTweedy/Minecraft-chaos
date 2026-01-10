// scripts/chaos/features/links/transfer/core/virtualInventory.js
/**
 * Virtual Inventory Manager
 * 
 * Predicts future inventory state by accounting for:
 * - In-flight transfers heading to containers
 * - Queued output items waiting to be inserted
 * - Queued input items waiting to be extracted
 * 
 * This prevents sending items to containers that will be full once pending operations complete.
 * 
 * State is persistent - only updated on actual changes (events/scans), not rebuilt every tick.
 */

/**
 * Creates a virtual inventory manager
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Virtual inventory manager
 */
export function createVirtualInventoryManager(cfg, deps) {
  const { getContainerKey } = deps;
  let nowTick = 0;
  
  // Store deps for use in updateState
  deps = { ...deps, getContainerKey };

  // Persistent inventory state per container
  // Map<containerKey, {
  //   actual: { byType: Map<typeId, amount>, totalItems: number, capacity: number, lastScannedTick: number },
  //   pending: { incoming: { byType: Map<typeId, amount>, total: number }, outgoing: { byType: Map<typeId, amount>, total: number } },
  //   virtual: { byType: Map<typeId, amount>, totalItems: number, capacity: number },
  //   dirty: boolean,
  //   dirtyReason: string | null,
  //   lastValidatedTick: number
  // }>
  const virtualInventoryState = new Map();

  // Track which prisms have dirty inventories (need scanning)
  const dirtyPrisms = new Set();

  /**
   * Update pending items tracking from in-flight transfers and queues
   * Called each tick to update pending items (does NOT update actual state)
   * @param {Array} inflight - Array of in-flight transfer jobs
   * @param {Map} queueByContainer - Map of container output queues
   * @param {Map} inputQueueByPrism - Optional: Map of input queues by prism
   */
  function updatePendingItems(inflight, queueByContainer, inputQueueByPrism = null) {
    // Update pending incoming (in-flight + output queues)
    for (const [containerKey, state] of virtualInventoryState.entries()) {
      // Clear pending incoming
      state.pending.incoming.byType.clear();
      state.pending.incoming.total = 0;
      state.pending.outgoing.byType.clear();
      state.pending.outgoing.total = 0;
    }

    // Aggregate pending incoming items from in-flight transfers
    for (const job of inflight || []) {
      if (!job || !job.containerKey || !job.itemTypeId || !job.amount) continue;
      
      const containerKey = job.containerKey;
      let state = virtualInventoryState.get(containerKey);
      if (!state) {
        // Create state if doesn't exist (will be populated on next scan)
        state = createEmptyState();
        virtualInventoryState.set(containerKey, state);
      }

      const currentByType = state.pending.incoming.byType.get(job.itemTypeId) || 0;
      state.pending.incoming.byType.set(job.itemTypeId, currentByType + job.amount);
      state.pending.incoming.total += job.amount;
    }

    // Aggregate pending incoming items from output queues
    for (const [containerKey, queue] of (queueByContainer || new Map()).entries()) {
      if (!queue || !Array.isArray(queue) || queue.length === 0) continue;

      let state = virtualInventoryState.get(containerKey);
      if (!state) {
        state = createEmptyState();
        virtualInventoryState.set(containerKey, state);
      }

      for (const job of queue) {
        if (!job || !job.itemTypeId || !job.amount) continue;
        
        const currentByType = state.pending.incoming.byType.get(job.itemTypeId) || 0;
        state.pending.incoming.byType.set(job.itemTypeId, currentByType + job.amount);
        state.pending.incoming.total += job.amount;
      }
    }

    // Aggregate pending outgoing items from input queues (future extraction)
    if (inputQueueByPrism) {
      for (const queues of inputQueueByPrism.values()) {
        if (!Array.isArray(queues)) continue;
        for (const entry of queues) {
          if (!entry || !entry.containerKey || !entry.itemTypeId || !entry.remainingAmount) continue;
          
          const containerKey = entry.containerKey;
          let state = virtualInventoryState.get(containerKey);
          if (!state) {
            state = createEmptyState();
            virtualInventoryState.set(containerKey, state);
          }

          const currentByType = state.pending.outgoing.byType.get(entry.itemTypeId) || 0;
          state.pending.outgoing.byType.set(entry.itemTypeId, currentByType + entry.remainingAmount);
          state.pending.outgoing.total += entry.remainingAmount;
        }
      }
    }

    // Update virtual state (actual + pending.incoming - pending.outgoing)
    updateVirtualState();
  }

  /**
   * Create empty state structure
   * @returns {Object} Empty state
   */
  function createEmptyState() {
    return {
      actual: {
        byType: new Map(),
        totalItems: 0,
        capacity: 0,
        lastScannedTick: 0,
      },
      pending: {
        incoming: { byType: new Map(), total: 0 },
        outgoing: { byType: new Map(), total: 0 },
      },
      virtual: {
        byType: new Map(),
        totalItems: 0,
        capacity: 0,
      },
      dirty: false,
      dirtyReason: null,
      lastValidatedTick: 0,
    };
  }

  /**
   * Update virtual state from actual + pending
   */
  function updateVirtualState() {
    for (const [containerKey, state] of virtualInventoryState.entries()) {
      // Clear virtual state
      state.virtual.byType.clear();
      state.virtual.totalItems = 0;

      // Virtual = actual + pending.incoming - pending.outgoing
      // Copy actual by-type amounts
      for (const [typeId, amount] of state.actual.byType.entries()) {
        state.virtual.byType.set(typeId, amount);
      }

      // Add pending incoming
      for (const [typeId, amount] of state.pending.incoming.byType.entries()) {
        const current = state.virtual.byType.get(typeId) || 0;
        state.virtual.byType.set(typeId, current + amount);
      }

      // Subtract pending outgoing
      for (const [typeId, amount] of state.pending.outgoing.byType.entries()) {
        const current = state.virtual.byType.get(typeId) || 0;
        const next = Math.max(0, current - amount);
        if (next <= 0) {
          state.virtual.byType.delete(typeId);
        } else {
          state.virtual.byType.set(typeId, next);
        }
      }

      // Calculate totals
      state.virtual.totalItems = 0;
      for (const amount of state.virtual.byType.values()) {
        state.virtual.totalItems += amount;
      }

      // Virtual capacity = actual capacity (capacity doesn't change with pending items)
      state.virtual.capacity = state.actual.capacity;
    }
  }

  /**
   * Update actual inventory state (only called on events/scans)
   * @param {string} containerKey - Container key
   * @param {Object} actualState - Actual inventory state: { byType: Map<typeId, amount>, totalItems: number, capacity: number }
   * @param {number} scannedTick - Tick when scanned
   */
  function updateInventoryState(containerKey, actualState, scannedTick = 0) {
    if (!containerKey || !actualState) return;

    let state = virtualInventoryState.get(containerKey);
    if (!state) {
      state = createEmptyState();
      virtualInventoryState.set(containerKey, state);
    }

    // Update actual state
    state.actual.byType.clear();
    for (const [typeId, amount] of actualState.byType.entries()) {
      state.actual.byType.set(typeId, amount);
    }
    state.actual.totalItems = actualState.totalItems || 0;
    state.actual.capacity = actualState.capacity || 0;
    state.actual.lastScannedTick = scannedTick || 0;

    // Clear dirty flag after updating
    state.dirty = false;
    state.dirtyReason = null;

    // Update virtual state
    updateVirtualState();
  }

  /**
   * Mark inventory as dirty (needs rescan)
   * @param {string} containerKey - Container key
   * @param {string} reason - Reason for dirty flag (e.g., "block_changed", "manual_change", "validation_failed")
   */
  function markInventoryDirty(containerKey, reason = null) {
    if (!containerKey) return;

    let state = virtualInventoryState.get(containerKey);
    if (!state) {
      state = createEmptyState();
      virtualInventoryState.set(containerKey, state);
    }

    state.dirty = true;
    state.dirtyReason = reason || "unknown";
  }

  /**
   * Clear dirty flag (mark as clean after rescan)
   * @param {string} containerKey - Container key
   */
  function clearDirty(containerKey) {
    if (!containerKey) return;
    const state = virtualInventoryState.get(containerKey);
    if (state) {
      state.dirty = false;
      state.dirtyReason = null;
    }
  }

  /**
   * Mark a prism as dirty (needs scanning)
   * @param {string} prismKey - Prism key
   * @param {string} reason - Reason for dirty flag
   */
  function markPrismDirty(prismKey, reason = null) {
    if (!prismKey) return;
    dirtyPrisms.add(prismKey);
  }

  /**
   * Clear dirty flag for a prism (after scanning)
   * @param {string} prismKey - Prism key
   */
  function clearPrismDirty(prismKey) {
    if (!prismKey) return;
    dirtyPrisms.delete(prismKey);
  }

  /**
   * Get all dirty prisms (prisms that need scanning)
   * @returns {Set<string>} Set of prism keys that are dirty
   */
  function getDirtyPrisms() {
    return new Set(dirtyPrisms); // Return a copy
  }

  /**
   * Get pending items for a container (for a specific type)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID (optional, if not provided returns total incoming)
   * @returns {number} Pending incoming amount for type, or total incoming if typeId not provided
   */
  function getPendingForContainer(containerKey, typeId = null) {
    if (!containerKey) return 0;
    const state = virtualInventoryState.get(containerKey);
    if (!state) return 0;
    
    if (typeId) {
      return state.pending.incoming.byType.get(typeId) || 0;
    }
    return state.pending.incoming.total || 0;
  }

  /**
   * Get all pending items for a container
   * @param {string} containerKey - Container key
   * @returns {Object} { incoming: { byType: Map<typeId, amount>, total: number }, outgoing: { byType: Map<typeId, amount>, total: number } }
   */
  function getAllPendingForContainer(containerKey) {
    if (!containerKey) {
      return {
        incoming: { byType: new Map(), total: 0 },
        outgoing: { byType: new Map(), total: 0 },
      };
    }
    const state = virtualInventoryState.get(containerKey);
    if (!state) {
      return {
        incoming: { byType: new Map(), total: 0 },
        outgoing: { byType: new Map(), total: 0 },
      };
    }
    return {
      incoming: {
        byType: new Map(state.pending.incoming.byType),
        total: state.pending.incoming.total,
      },
      outgoing: {
        byType: new Map(state.pending.outgoing.byType),
        total: state.pending.outgoing.total,
      },
    };
  }

  /**
   * Get virtual inventory state for a container (predicted state)
   * @param {string} containerKey - Container key
   * @returns {Object|null} Virtual inventory state: { byType: Map<typeId, amount>, totalItems: number, capacity: number }
   */
  function getVirtualInventory(containerKey) {
    if (!containerKey) return null;
    const state = virtualInventoryState.get(containerKey);
    if (!state) return null;

    return {
      byType: new Map(state.virtual.byType),
      totalItems: state.virtual.totalItems,
      capacity: state.virtual.capacity,
    };
  }

  /**
   * Calculate virtual capacity for a container
   * Accounts for: current capacity - reservations - pending incoming items + pending outgoing items
   * @param {string} containerKey - Container key
   * @param {number} currentCapacity - Current available capacity (from cache)
   * @param {number} reserved - Currently reserved capacity
   * @param {string} typeId - Item type ID (optional, for type-specific calculation)
   * @param {number} reservedForType - Reserved capacity for this type (optional)
   * @returns {number} Virtual available capacity
   */
  function getVirtualCapacity(containerKey, currentCapacity, reserved, typeId = null, reservedForType = 0) {
    if (!containerKey || currentCapacity <= 0) return 0;

    const state = virtualInventoryState.get(containerKey);
    if (!state) {
      // No virtual state - use current capacity
      return Math.max(0, currentCapacity - reserved);
    }

    // Get pending incoming items for this type (items being added)
    const pendingIncoming = typeId 
      ? (state.pending.incoming.byType.get(typeId) || 0)
      : state.pending.incoming.total;

    // Get pending outgoing items for this type (items being removed)
    const pendingOutgoing = typeId
      ? (state.pending.outgoing.byType.get(typeId) || 0)
      : state.pending.outgoing.total;

    // Virtual capacity = current - reserved - pending incoming + pending outgoing
    if (typeId) {
      const virtual = currentCapacity - reservedForType - pendingIncoming + pendingOutgoing;
      return Math.max(0, virtual);
    } else {
      const virtual = currentCapacity - reserved - pendingIncoming + pendingOutgoing;
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
   * Add pending items (legacy function - now handled by updatePendingItems)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID
   * @param {number} amount - Amount to add as pending
   */
  function addPending(containerKey, typeId, amount) {
    if (!containerKey || !typeId || amount <= 0) return;
    
    let state = virtualInventoryState.get(containerKey);
    if (!state) {
      state = createEmptyState();
      virtualInventoryState.set(containerKey, state);
    }

    const current = state.pending.incoming.byType.get(typeId) || 0;
    state.pending.incoming.byType.set(typeId, current + amount);
    state.pending.incoming.total += amount;

    updateVirtualState();
  }

  /**
   * Remove pending items (legacy function - now handled by updatePendingItems)
   * @param {string} containerKey - Container key
   * @param {string} typeId - Item type ID
   * @param {number} amount - Amount to remove from pending
   */
  function removePending(containerKey, typeId, amount) {
    if (!containerKey || !typeId || amount <= 0) return;
    
    const state = virtualInventoryState.get(containerKey);
    if (!state) return;

    const current = state.pending.incoming.byType.get(typeId) || 0;
    const next = Math.max(0, current - amount);
    
    if (next === 0) {
      state.pending.incoming.byType.delete(typeId);
    } else {
      state.pending.incoming.byType.set(typeId, next);
    }
    
    state.pending.incoming.total = Math.max(0, state.pending.incoming.total - amount);
    
    updateVirtualState();
  }

  /**
   * Cleanup stale entries (remove entries not touched for >maxAge ticks)
   * @param {number} maxAge - Maximum age in ticks (default: 1000)
   */
  function cleanupStaleEntries(maxAge = 1000) {
    const cutoffTick = nowTick - maxAge;
    const toDelete = [];

    for (const [containerKey, state] of virtualInventoryState.entries()) {
      const lastTouched = Math.max(
        state.actual.lastScannedTick || 0,
        state.lastValidatedTick || 0
      );

      // If entry hasn't been touched recently and has no pending items, mark for deletion
      if (lastTouched < cutoffTick && state.pending.incoming.total === 0 && state.pending.outgoing.total === 0) {
        toDelete.push(containerKey);
      }
    }

    for (const containerKey of toDelete) {
      virtualInventoryState.delete(containerKey);
    }

    return toDelete.length;
  }

  /**
   * Update virtual inventory state from all sources
   * Call this each tick before checking capacities
   * @param {Array} inflight - In-flight transfers array
   * @param {Map} queueByContainer - Output queue map
   * @param {Map} inputQueueByPrism - Optional: Input queues by prism (Map<prismKey, Array<queueEntries>>)
   */
  function updateState(inflight, queueByContainer, inputQueueByPrism = null) {
    // Update pending items tracking from all sources
    updatePendingItems(inflight, queueByContainer, inputQueueByPrism);
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
    markPrismDirty,
    clearPrismDirty,
    getDirtyPrisms,
    markInventoryDirty,
    clearDirty,
  };
}
