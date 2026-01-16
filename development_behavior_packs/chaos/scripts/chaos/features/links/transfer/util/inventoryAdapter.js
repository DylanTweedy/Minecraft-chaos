// scripts/chaos/features/links/transfer/util/inventoryAdapter.js
import { ItemStack } from "@minecraft/server";

// -----------------------------------------------------------------------------
// Inventory Adapter
// -----------------------------------------------------------------------------
// Centralized inventory/container helpers for the transfer pipeline.
// This intentionally replaces the removed legacy folder: ../inventory/*
//
// Design goals:
// - Safe: never throw; return best-effort results
// - Small surface area: pipeline phases call these helpers instead of re-implementing
// - Extensible: furnace/filtered/sided rules can be upgraded later without touching phases
// -----------------------------------------------------------------------------

function _tryGetBlockContainer(block) {
  try {
    const inv = block?.getComponent?.("minecraft:inventory");
    return inv?.container || null;
  } catch {
    return null;
  }
}

export function getInventoryContainer(block) {
  return _tryGetBlockContainer(block);
}

export function isFurnaceBlock(block) {
  const id = block?.typeId;
  return id === "minecraft:furnace" || id === "minecraft:blast_furnace" || id === "minecraft:smoker";
}

// Minimal furnace slot map (convention: 0=input, 1=fuel, 2=output)
export function getFurnaceSlots(_block) {
  return { input: 0, fuel: 1, output: 2 };
}

export function getAttachedInventoryInfo(block, dim) {
  const container = _tryGetBlockContainer(block);
  if (!container) return null;
  return { container, block, entity: null, dim };
}

export function getAllAdjacentInventories(block, dim) {
  const out = [];
  try {
    const loc = block?.location;
    if (!loc || !dim) return out;
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    for (const d of dirs) {
      const b = dim.getBlock({ x: loc.x + d.x, y: loc.y + d.y, z: loc.z + d.z });
      const c = _tryGetBlockContainer(b);
      if (!c) continue;
      out.push({ block: b, container: c, dim, pos: b.location });
    }
  } catch {
    // ignore
  }
  return out;
}

function _safeCreateStack(typeId, amount) {
  try {
    return new ItemStack(typeId, amount);
  } catch {
    return null;
  }
}

function _tryInsertIntoContainer(container, typeId, amount) {
  try {
    if (!container) return { ok: false, inserted: 0 };
    let remaining = Math.max(0, amount | 0);
    if (remaining === 0) return { ok: true, inserted: 0 };

    const probe = _safeCreateStack(typeId, 1);
    if (!probe) return { ok: false, inserted: 0 };
    const max = probe.maxAmount || 64;
    const size = container.size || 0;

    let inserted = 0;

    // merge existing
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      const cur = it.amount | 0;
      if (cur >= max) continue;
      const add = Math.min(max - cur, remaining);
      if (add <= 0) continue;
      it.amount = cur + add;
      container.setItem(i, it);
      remaining -= add;
      inserted += add;
    }

    // fill empty
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (it) continue;
      const put = Math.min(max, remaining);
      const stack = _safeCreateStack(typeId, put);
      if (!stack) break;
      container.setItem(i, stack);
      remaining -= put;
      inserted += put;
    }

    return { ok: remaining === 0, inserted };
  } catch {
    return { ok: false, inserted: 0 };
  }
}

export function tryInsertAmountForContainer(containerInfo, itemTypeId, amount) {
  const container = containerInfo?.container || containerInfo;
  return _tryInsertIntoContainer(container, itemTypeId, amount).ok;
}

export function tryInsertIntoInventories(inventories, itemTypeId, amount) {
  try {
    if (!Array.isArray(inventories) || inventories.length === 0) return false;
    let remaining = Math.max(0, amount | 0);
    if (remaining === 0) return true;

    for (const inv of inventories) {
      const container = inv?.container || inv;
      const res = _tryInsertIntoContainer(container, itemTypeId, remaining);
      remaining -= res.inserted;
      if (remaining <= 0) return true;
    }
    return remaining <= 0;
  } catch {
    return false;
  }
}

export function getTotalCountForType(inventories, itemTypeId) {
  let total = 0;
  try {
    if (!Array.isArray(inventories)) return 0;
    for (const inv of inventories) {
      const c = inv?.container || inv;
      const size = c?.size || 0;
      for (let i = 0; i < size; i++) {
        const it = c.getItem(i);
        if (it && it.typeId === itemTypeId) total += (it.amount | 0);
      }
    }
  } catch {
    // ignore
  }
  return total;
}

export function getRandomItemFromInventories(inventories) {
  try {
    if (!Array.isArray(inventories) || inventories.length === 0) return null;
    let chosen = null;
    let seen = 0;
    for (const inv of inventories) {
      const c = inv?.container || inv;
      const size = c?.size || 0;
      for (let i = 0; i < size; i++) {
        const it = c.getItem(i);
        if (!it) continue;
        seen++;
        if ((Math.random() * seen) < 1) chosen = { item: it, slot: i, container: c };
      }
    }
    return chosen;
  } catch {
    return null;
  }
}

export function findInputSlotForContainer(container, itemTypeId) {
  try {
    const c = container?.container || container;
    const size = c?.size || 0;
    for (let i = 0; i < size; i++) {
      const it = c.getItem(i);
      if (it && it.typeId === itemTypeId) return i;
    }
  } catch {
    // ignore
  }
  return -1;
}

export function decrementInputSlotSafe(container, slot, amount) {
  try {
    const c = container?.container || container;
    const it = c?.getItem?.(slot);
    if (!it) return false;
    const dec = Math.max(1, amount | 0);
    const next = (it.amount | 0) - dec;
    if (next > 0) {
      it.amount = next;
      c.setItem(slot, it);
    } else {
      c.setItem(slot, undefined);
    }
    return true;
  } catch {
    return false;
  }
}

export function decrementInputSlotsForType(container, itemTypeId, amount) {
  try {
    const c = container?.container || container;
    let remaining = Math.max(0, amount | 0);
    if (remaining === 0) return true;
    const size = c?.size || 0;
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = c.getItem(i);
      if (!it || it.typeId !== itemTypeId) continue;
      const take = Math.min(it.amount | 0, remaining);
      remaining -= take;
      const next = (it.amount | 0) - take;
      if (next > 0) {
        it.amount = next;
        c.setItem(i, it);
      } else {
        c.setItem(i, undefined);
      }
    }
    return remaining <= 0;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Filters / Reservations placeholders (until your new system lands)
// -----------------------------------------------------------------------------
export function getFilterContainer() { return null; }
export function getFilterSet() { return null; }

export function getInsertCapacityWithReservations(containerInfo, _itemTypeId) {
  try {
    const c = containerInfo?.container || containerInfo;
    return (c && typeof c.size === "number") ? (c.size * 64) : 0;
  } catch {
    return 0;
  }
}
export function getReservedForContainer() { return 0; }
export function reserveContainerSlot() { return false; }
export function releaseContainerSlot() { return false; }
export function clearReservations() {}

// -----------------------------------------------------------------------------
// Balance (migrated from legacy inventory/balance.js)
// -----------------------------------------------------------------------------
export function calculateBalancedTransferAmount(args) {
  try {
    const {
      sourceCount,
      destCount,
      maxTransfer,
      minTransfer,
      destCapacity,
    } = args || {};

    const src = Math.max(0, sourceCount | 0);
    const dst = Math.max(0, destCount | 0);
    const cap = Math.max(0, destCapacity | 0);
    const maxT = Math.max(0, maxTransfer | 0);
    const minT = Math.max(0, minTransfer | 0);

    const total = src + dst;
    if (total <= 0) return { ok: false, amount: 0, reason: "empty" };

    const target = Math.floor(total / 2);
    if (dst >= target) return { ok: false, amount: 0, reason: "already_balanced" };

    let needed = target - dst;
    let amt = Math.min(needed, src, maxT);
    if (cap > 0) amt = Math.min(amt, cap);
    if (amt < minT) return { ok: false, amount: 0, reason: "below_min" };

    return { ok: true, amount: amt, reason: "ok" };
  } catch {
    return { ok: false, amount: 0, reason: "error" };
  }
}
