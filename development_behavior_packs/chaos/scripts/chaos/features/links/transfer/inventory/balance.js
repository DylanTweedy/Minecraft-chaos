// scripts/chaos/features/links/transfer/inventory/balance.js
/**
 * Balance Calculator
 * 
 * Calculates transfer amounts for 50/50 item distribution between containers.
 * Used for unfiltered (unattuned) prisms to ensure even distribution.
 * 
 * Filtered (attuned) prisms use fill-to-capacity behavior (handled elsewhere).
 */

import { getTotalCountForType } from "./inventory.js";

/**
 * Calculate balanced transfer amount for 50/50 distribution
 * 
 * Algorithm:
 * 1. Calculate total = source_count + destination_count
 * 2. Calculate target = total / 2 (ideal 50/50 balance point)
 * 3. Calculate transfer_amount = source_count - target (if source > target)
 * 4. Limit by available source items and destination capacity
 * 
 * @param {number} sourceCount - Count of item type in source container
 * @param {number} destCount - Count of item type in destination container
 * @param {number} sourceAvailable - Available items in source (for transfer)
 * @param {number} destCapacity - Available capacity in destination
 * @param {Object} options - Options: { minTransfer, maxTransfer }
 * @returns {Object} { amount: number, reason: string, cancelled: boolean }
 */
export function calculateBalancedTransferAmount(sourceCount, destCount, sourceAvailable, destCapacity, options = {}) {
  const {
    minTransfer = 1,     // Minimum transfer amount (default: 1)
    maxTransfer = Infinity, // Maximum transfer amount (default: unlimited)
  } = options;

  // Calculate total and target (50/50 balance point)
  const total = sourceCount + destCount;
  
  // Edge case: if total is 0, nothing to transfer
  if (total === 0) {
    return { amount: 0, reason: "no_items", cancelled: true };
  }
  
  // Edge case: if total is 1, transfer 1 item (can't split 1 item)
  if (total === 1) {
    if (sourceCount === 1 && destCount === 0 && sourceAvailable >= 1 && destCapacity >= 1) {
      return { amount: 1, reason: "ok", cancelled: false };
    }
    return { amount: 0, reason: "no_items", cancelled: true };
  }
  
  const target = Math.floor(total / 2); // Ideal balance point (50%)

  // Calculate difference
  const difference = sourceCount - destCount;

  // Only transfer if source has more than destination (difference > 0)
  // This ensures items flow from high to low
  if (difference <= 0) {
    return { amount: 0, reason: "destination_balanced", cancelled: true };
  }

  // Check if source doesn't have enough to balance
  // Only cancel if source is already at or below target
  if (sourceCount <= target) {
    return { amount: 0, reason: "source_insufficient", cancelled: true };
  }

  // Calculate transfer amount to reach balance
  let amount = sourceCount - target; // Amount to balance

  // Limit by available source items
  amount = Math.min(amount, sourceAvailable);

  // Limit by destination capacity
  amount = Math.min(amount, destCapacity);

  // Limit by max transfer (optional: integrate with level system)
  amount = Math.min(amount, maxTransfer);

  // Apply minimum transfer
  if (amount < minTransfer) {
    return { amount: 0, reason: "below_minimum", cancelled: true };
  }

  return { amount, reason: "ok", cancelled: false };
}

/**
 * Get item count for a specific type in a container
 * Wrapper for consistency (uses existing getTotalCountForType)
 * 
 * @param {Container} container - Minecraft container
 * @param {string} typeId - Item type ID
 * @returns {number} Count of items
 */
export function getItemCountForType(container, typeId) {
  return getTotalCountForType(container, typeId);
}

/**
 * Get item count for a specific type across multiple inventories (aggregate)
 * 
 * @param {Array} inventories - Array of inventory info objects
 * @param {string} typeId - Item type ID
 * @returns {number} Total count across all inventories
 */
export function getItemCountForTypeAcrossInventories(inventories, typeId) {
  if (!Array.isArray(inventories)) return 0;
  let total = 0;
  for (const invInfo of inventories) {
    if (!invInfo?.container) continue;
    total += getTotalCountForType(invInfo.container, typeId);
  }
  return total;
}
