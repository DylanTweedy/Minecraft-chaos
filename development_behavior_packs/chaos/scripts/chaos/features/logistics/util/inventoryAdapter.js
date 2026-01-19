// scripts/chaos/features/logistics/util/inventoryAdapter.js
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
  } catch (e) {
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
  } catch (e) {
    // ignore
  }
  return out;
}

function _safeCreateStack(typeId, amount) {
  try {
    return new ItemStack(typeId, amount);
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
    // ignore
  }
  return total;
}

// NOTE: This MUST return the "itemSource" shape expected by pushTransfers/hybridTransfers:
// { container, slot, stack, inventoryIndex, entity?, block?, dim? }
// The previous adapter returned { item, slot, container } which caused ALL transfers to silently fail
// at "if (!sourceStack)" (no_item) gates.
export function getRandomItemFromInventories(inventories, filterSet) {
  try {
    if (!Array.isArray(inventories) || inventories.length === 0) return null;

    const hasFilter = !!(filterSet && filterSet.size > 0);
    let chosen = null;
    let seen = 0;

    for (let invIndex = 0; invIndex < inventories.length; invIndex++) {
      const inv = inventories[invIndex];
      const c = inv?.container || inv;
      const size = c?.size || 0;
      for (let slot = 0; slot < size; slot++) {
        const it = c.getItem(slot);
        if (!it || (it.amount | 0) <= 0) continue;
        if (hasFilter && filterSet.has(it.typeId)) continue;

        seen++;
        if ((Math.random() * seen) < 1) {
          chosen = {
            container: c,
            slot,
            stack: it,
            inventoryIndex: invIndex,
            entity: inv?.entity || null,
            block: inv?.block || null,
            dim: inv?.dim || null,
          };
        }
      }
    }

    return chosen;
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Filters / Reservations placeholders (until your new system lands)
// -----------------------------------------------------------------------------
export function getFilterContainer() { return null; }
export function getFilterSet() { return null; }

// -----------------------------------------------------------------------------
// Reservations (replacement for legacy virtualInventory.js)
//
// Goal: keep InputQueues + PushTransfers behaviour intact WITHOUT any separate
// "virtual inventory manager". We only need one thing: a lightweight, in-memory
// reservation book so multiple prisms don't overbook the same destination.
//
// This is *not persisted*. It's rebuilt best-effort from inflight jobs on load
// (see controller.js) and naturally self-heals if it drifts.
// -----------------------------------------------------------------------------

// containerKey -> { total: number, byType: Map<string, number> }
const _reservations = new Map();

function _getState(containerKey) {
  let s = _reservations.get(containerKey);
  if (!s) {
    s = { total: 0, byType: new Map() };
    _reservations.set(containerKey, s);
  }
  return s;
}

export function getReservedForContainer(containerKey) {
  const s = _reservations.get(containerKey);
  if (!s) return { total: 0, byType: new Map() };
  return s;
}

export function reserveContainerSlot(containerKey, typeId, amount) {
  try {
    const amt = Math.max(0, amount | 0);
    if (!containerKey || amt <= 0) return false;

    const s = _getState(containerKey);
    s.total = (s.total | 0) + amt;

    const key = typeId || "*";
    const prev = s.byType.get(key) || 0;
    s.byType.set(key, (prev | 0) + amt);
    return true;
  } catch (e) {
    return false;
  }
}

export function releaseContainerSlot(containerKey, typeId, amount) {
  try {
    const amt = Math.max(0, amount | 0);
    if (!containerKey || amt <= 0) return false;

    const s = _reservations.get(containerKey);
    if (!s) return false;

    const key = typeId || "*";
    const prev = s.byType.get(key) || 0;
    const next = Math.max(0, (prev | 0) - amt);
    if (next > 0) s.byType.set(key, next);
    else s.byType.delete(key);

    s.total = Math.max(0, (s.total | 0) - amt);
    if (s.total <= 0 && s.byType.size === 0) _reservations.delete(containerKey);
    return true;
  } catch (e) {
    return false;
  }
}

export function clearReservations() {
  _reservations.clear();
}

// Signature-compatible capacity helper.
//
// Legacy call sites pass: (containerKey, container, typeId, stack, block, reservationProvider?)
// The new adapter may also call it with (containerInfo, typeId).
export function getInsertCapacityWithReservations(
  containerKeyOrInfo,
  containerMaybe,
  typeIdMaybe,
  stackMaybe,
  _block,
  _reservationProvider
) {
  try {
    // Detect "new" call shape: (containerInfo, typeId)
    const isInfoShape =
      containerKeyOrInfo &&
      typeof containerKeyOrInfo === "object" &&
      (containerKeyOrInfo.container || containerKeyOrInfo.block);

    const containerKey = isInfoShape ? null : containerKeyOrInfo;
    const containerInfo = isInfoShape ? containerKeyOrInfo : null;
    const container =
      (containerInfo && (containerInfo.container || containerInfo)) ||
      containerMaybe;

    const typeId = isInfoShape ? containerMaybe : typeIdMaybe;
    const stack = isInfoShape ? null : stackMaybe;

    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const baseCapacity =
      container && typeof container.size === "number" ? (container.size * maxStack) : 0;

    // Apply reservations (total + per-type).
    if (containerKey) {
      const state = getReservedForContainer(containerKey);
      const reservedTotal = state && typeof state.total === "number" ? state.total : 0;
      const reservedForType =
        state && state.byType && typeId ? (state.byType.get(typeId) || 0) : 0;

      // If a type is specified, subtract type-specific reservations first.
      // Otherwise fall back to total reservations.
      const reserved = typeId ? reservedForType : reservedTotal;
      return Math.max(0, (baseCapacity | 0) - (reserved | 0));
    }

    return baseCapacity | 0;
  } catch (e) {
    return 0;
  }
}

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
  } catch (e) {
    return { ok: false, amount: 0, reason: "error" };
  }
}


