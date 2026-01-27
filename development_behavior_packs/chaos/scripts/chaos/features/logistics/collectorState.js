// scripts/chaos/features/logistics/collectorState.js
import { ItemStack } from "@minecraft/server";
import { key as makeKey } from "./keys.js";

const COLLECTOR_ID = "chaos:collector";

const BUFFER_MAX_SLOTS = 9;
const BUFFER_MAX_PER_TYPE = BUFFER_MAX_SLOTS * 64;
const VIRTUAL_SIZE = BUFFER_MAX_SLOTS;

const DEFAULT_MAX_CHARGE = 256;
const FILTER_EMPTY_MODE = "EMPTY_ACCEPTS_ALL";

const stateByKey = new Map();
const virtualContainerByKey = new Map();

function ensureFailCounts(state) {
  if (!state.failCounts || typeof state.failCounts !== "object") state.failCounts = {};
  return state.failCounts;
}

function createDefaultState() {
  return {
    buffer: {},
    filters: [],
    charge: DEFAULT_MAX_CHARGE,
    maxCharge: DEFAULT_MAX_CHARGE,
    anchorKey: null,
    networkEnabled: false,
    readyToVacuum: true,
    readyReason: null,
    counters: {
      vacuumed: 0,
      insertedInv: 0,
      handedNetwork: 0,
    },
    failCounts: {},
  };
}

function getCollectorState(key) {
  if (!key) return null;
  let st = stateByKey.get(key);
  if (!st || typeof st !== "object") {
    st = createDefaultState();
    stateByKey.set(key, st);
  }
  if (!st.buffer || typeof st.buffer !== "object") st.buffer = {};
  if (!Array.isArray(st.filters)) st.filters = [];
  if (!st.counters || typeof st.counters !== "object") {
    st.counters = { vacuumed: 0, insertedInv: 0, handedNetwork: 0 };
  }
  if (!Number.isFinite(st.charge)) st.charge = 0;
  if (!Number.isFinite(st.maxCharge) || st.maxCharge <= 0) st.maxCharge = DEFAULT_MAX_CHARGE;
  ensureFailCounts(st);
  return st;
}

function setCollectorState(key, state) {
  if (!key || !state || typeof state !== "object") return;
  stateByKey.set(key, state);
}

function getFilterMode() {
  return FILTER_EMPTY_MODE;
}

function getCollectorFilters(key) {
  const st = getCollectorState(key);
  if (!st) return [];
  return Array.isArray(st.filters) ? st.filters.slice() : [];
}

function toggleCollectorFilter(key, typeId) {
  const st = getCollectorState(key);
  if (!st || !typeId) return null;
  const list = Array.isArray(st.filters) ? st.filters : [];
  const idx = list.indexOf(typeId);
  let added = false;
  let removed = false;
  if (idx >= 0) {
    list.splice(idx, 1);
    removed = true;
  } else {
    list.push(typeId);
    added = true;
  }
  st.filters = list;
  return { added, removed, size: list.length };
}

function clearCollectorFilters(key) {
  const st = getCollectorState(key);
  if (!st) return false;
  st.filters = [];
  return true;
}

function filterAcceptsItem(state, typeId) {
  if (!state || !typeId) return false;
  const list = Array.isArray(state.filters) ? state.filters : [];
  if (list.length === 0) return FILTER_EMPTY_MODE === "EMPTY_ACCEPTS_ALL";
  return list.includes(typeId);
}

function getBufferForKey(key) {
  const st = getCollectorState(key);
  if (!st) return {};
  if (!st.buffer || typeof st.buffer !== "object") st.buffer = {};
  return st.buffer;
}

function getBufferTotals(buf) {
  let total = 0;
  let types = 0;
  let slotsUsed = 0;
  for (const [typeId, count] of Object.entries(buf || {})) {
    const n = Math.max(0, Number(count) || 0);
    if (n <= 0) continue;
    total += n;
    types++;
    slotsUsed += Math.ceil(n / 64);
  }
  return { total, types, slotsUsed };
}

function getBufferSnapshot(key) {
  const buf = getBufferForKey(key);
  const totals = getBufferTotals(buf);
  return {
    total: totals.total,
    types: totals.types,
    slotsUsed: totals.slotsUsed,
    slotCapacity: BUFFER_MAX_SLOTS,
    items: { ...buf },
  };
}

function canInsertIntoBuffer(buf, typeId, amount) {
  if (!typeId) return false;
  const amt = Math.max(0, amount | 0);
  if (amt <= 0) return false;
  const current = Math.max(0, Number(buf[typeId]) || 0);
  if ((current + amt) > BUFFER_MAX_PER_TYPE) return false;
  const totals = getBufferTotals(buf);
  const currentSlots = Math.ceil(current / 64);
  const nextSlots = Math.ceil((current + amt) / 64);
  const addedSlots = Math.max(0, nextSlots - currentSlots);
  return (totals.slotsUsed + addedSlots) <= BUFFER_MAX_SLOTS;
}

function tryInsertIntoBuffer(key, typeId, amount) {
  const buf = getBufferForKey(key);
  const amt = Math.max(0, amount | 0);
  if (amt <= 0) return 0;
  if (!canInsertIntoBuffer(buf, typeId, amt)) return 0;
  const current = Math.max(0, Number(buf[typeId]) || 0);
  buf[typeId] = current + amt;
  return amt;
}

function removeFromBuffer(key, typeId, amount) {
  const buf = getBufferForKey(key);
  const amt = Math.max(0, amount | 0);
  if (amt <= 0) return 0;
  const current = Math.max(0, Number(buf[typeId]) || 0);
  if (current <= 0) return 0;
  const removed = Math.min(current, amt);
  const next = Math.max(0, current - removed);
  if (next > 0) buf[typeId] = next;
  else delete buf[typeId];
  return removed;
}

function bufferToSlots(buf) {
  const slots = new Array(VIRTUAL_SIZE).fill(undefined);
  let idx = 0;
  for (const [typeId, count] of Object.entries(buf || {})) {
    let remaining = Math.max(0, Number(count) || 0);
    while (remaining > 0 && idx < VIRTUAL_SIZE) {
      const n = Math.min(remaining, 64);
      try {
        slots[idx] = new ItemStack(typeId, n);
      } catch {
        slots[idx] = undefined;
      }
      remaining -= n;
      idx++;
    }
    if (idx >= VIRTUAL_SIZE) break;
  }
  return slots;
}

function slotsToBuffer(slots, buf, state) {
  const next = {};
  for (const it of slots) {
    if (!it || !it.typeId) continue;
    const cur = Math.max(0, Number(next[it.typeId]) || 0);
    next[it.typeId] = cur + (it.amount | 0);
  }
  const prevTotals = getBufferTotals(buf);
  for (const key of Object.keys(buf)) delete buf[key];
  for (const [typeId, count] of Object.entries(next)) buf[typeId] = count;
  const nextTotals = getBufferTotals(buf);
  const removed = Math.max(0, (prevTotals.total | 0) - (nextTotals.total | 0));
  if (removed > 0 && state?.counters) {
    state.counters.handedNetwork = Math.max(0, (state.counters.handedNetwork | 0) + removed);
  }
}

function createVirtualContainer(key) {
  return {
    size: VIRTUAL_SIZE,
    getItem(slot) {
      const buf = getBufferForKey(key);
      const slots = bufferToSlots(buf);
      return slots[slot];
    },
    setItem(slot, item) {
      const buf = getBufferForKey(key);
      const slots = bufferToSlots(buf);
      slots[slot] = item;
      const state = getCollectorState(key);
      slotsToBuffer(slots, buf, state);
    },
  };
}

function getVirtualContainerForKey(key) {
  let c = virtualContainerByKey.get(key);
  if (!c) {
    c = createVirtualContainer(key);
    virtualContainerByKey.set(key, c);
  }
  return c;
}

function getVirtualContainerForBlock(block, key) {
  if (!block || block.typeId !== COLLECTOR_ID) return null;
  let resolvedKey = key;
  if (!resolvedKey) {
    const dimId = block.dimension?.id;
    const loc = block.location;
    if (dimId && loc) resolvedKey = makeKey(dimId, loc.x, loc.y, loc.z);
  }
  if (!resolvedKey) return null;
  const st = getCollectorState(resolvedKey);
  if (!st?.networkEnabled) return null;
  return getVirtualContainerForKey(resolvedKey);
}

function getCollectorKeyFromBlock(block) {
  if (!block || block.typeId !== COLLECTOR_ID) return null;
  const dimId = block.dimension?.id;
  const loc = block.location;
  if (!dimId || !loc) return null;
  return makeKey(dimId, loc.x, loc.y, loc.z);
}

function setCollectorNetworkEnabled(key, enabled) {
  const st = getCollectorState(key);
  if (!st) return false;
  st.networkEnabled = !!enabled;
  return st.networkEnabled;
}

function isCollectorNetworkEnabled(key) {
  const st = getCollectorState(key);
  return !!st?.networkEnabled;
}

function markCollectorFail(key, reason) {
  const st = getCollectorState(key);
  if (!st || !reason) return;
  const counts = ensureFailCounts(st);
  counts[reason] = (counts[reason] | 0) + 1;
}

function setCollectorReadyState(key, ready, reason) {
  const st = getCollectorState(key);
  if (!st) return;
  st.readyToVacuum = !!ready;
  st.readyReason = ready ? null : (reason || null);
}

export {
  COLLECTOR_ID,
  BUFFER_MAX_SLOTS,
  DEFAULT_MAX_CHARGE,
  FILTER_EMPTY_MODE,
  stateByKey,
  getCollectorState,
  setCollectorState,
  getCollectorFilters,
  toggleCollectorFilter,
  clearCollectorFilters,
  filterAcceptsItem,
  getBufferForKey,
  getBufferSnapshot,
  getBufferTotals,
  tryInsertIntoBuffer,
  canInsertIntoBuffer,
  removeFromBuffer,
  getVirtualContainerForBlock,
  getCollectorKeyFromBlock,
  setCollectorNetworkEnabled,
  isCollectorNetworkEnabled,
  markCollectorFail,
  setCollectorReadyState,
};
