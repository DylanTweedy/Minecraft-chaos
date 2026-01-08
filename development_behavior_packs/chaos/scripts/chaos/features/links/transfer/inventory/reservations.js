// scripts/chaos/features/links/transfer/inventory/reservations.js
import { getFurnaceSlots, isFuelStack, getSlotInsertCapacity, makeProbeStack } from "./inventory.js";

const reservedByContainer = new Map();

export function clearReservations() {
  reservedByContainer.clear();
}

export function getReservedForContainer(containerKey) {
  const entry = reservedByContainer.get(containerKey);
  if (!entry) return { total: 0, byType: new Map() };
  return entry;
}

export function reserveContainerSlot(containerKey, typeId, count) {
  if (!containerKey || !typeId || count <= 0) return;
  let entry = reservedByContainer.get(containerKey);
  if (!entry) {
    entry = { total: 0, byType: new Map() };
    reservedByContainer.set(containerKey, entry);
  }
  entry.total += count;
  const prev = entry.byType.get(typeId) || 0;
  entry.byType.set(typeId, prev + count);
}

export function releaseContainerSlot(containerKey, typeId, count) {
  if (!containerKey || !typeId || count <= 0) return;
  const entry = reservedByContainer.get(containerKey);
  if (!entry) return;
  entry.total = Math.max(0, entry.total - count);
  const prev = entry.byType.get(typeId) || 0;
  const next = Math.max(0, prev - count);
  if (next === 0) entry.byType.delete(typeId);
  else entry.byType.set(typeId, next);
  if (entry.total <= 0 && entry.byType.size === 0) reservedByContainer.delete(containerKey);
}

export function getInsertCapacityWithReservations(containerKey, container, typeId, stack, containerBlock) {
  try {
    const size = container.size;
    const slots = getFurnaceSlots(container, containerBlock);
    if (slots) {
      const probe = stack || makeProbeStack(typeId);
      const maxStack = Math.max(1, probe?.maxAmount || 64);
      const targetSlot = isFuelStack(probe) ? slots.fuel : slots.input;
      const slotCapacity = getSlotInsertCapacity(container, targetSlot, typeId, maxStack);
      const reserved = getReservedForContainer(containerKey);
      const reservedForType = reserved.byType ? (reserved.byType.get(typeId) || 0) : 0;
      return Math.max(0, slotCapacity - reservedForType);
    }

    let stackRoom = 0;
    let emptySlots = 0;
    const maxStack = Math.max(1, stack?.maxAmount || 64);

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) {
        emptySlots++;
        continue;
      }
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || maxStack;
      if (it.amount < max) stackRoom += (max - it.amount);
    }

    const reservedTotal = getReservedForContainer(containerKey).total;
    const capacity = stackRoom + (emptySlots * maxStack);
    return Math.max(0, capacity - reservedTotal);
  } catch (_) {
    return 0;
  }
}

export function canInsertOneWithReservations(containerKey, container, typeId) {
  try {
    const capacity = getInsertCapacityWithReservations(containerKey, container, typeId, null);
    return capacity >= 1;
  } catch (_) {
    return false;
  }
}
