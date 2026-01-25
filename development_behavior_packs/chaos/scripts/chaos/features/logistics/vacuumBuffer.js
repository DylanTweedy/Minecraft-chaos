// scripts/chaos/features/logistics/vacuumBuffer.js
import { ItemStack } from "@minecraft/server";
import { key as makeKey } from "./keys.js";

const HOPPER_ID = "chaos:vacuum_hopper";
const BUFFER_MAX_TYPES = 9;
const BUFFER_MAX_PER_TYPE = 64 * 9;
const VIRTUAL_SIZE = 9;

const bufferByKey = new Map(); // key -> { [typeId]: count }
const virtualContainerByKey = new Map(); // key -> container

function getBufferForKey(key) {
  let buf = bufferByKey.get(key);
  if (!buf || typeof buf !== "object") {
    buf = {};
    bufferByKey.set(key, buf);
  }
  return buf;
}

function getBufferSnapshot(key) {
  const buf = bufferByKey.get(key);
  if (!buf || typeof buf !== "object") return { total: 0, types: 0, items: {} };
  let total = 0;
  let types = 0;
  for (const [typeId, count] of Object.entries(buf)) {
    const n = Math.max(0, Number(count) || 0);
    if (n > 0) {
      total += n;
      types++;
    }
  }
  return { total, types, items: buf };
}

function tryInsertIntoBuffer(key, itemTypeId, amount) {
  const buf = getBufferForKey(key);
  const safeAmount = Math.max(0, amount | 0);
  if (safeAmount <= 0 || !itemTypeId) return 0;
  const existingTypes = Object.keys(buf).filter((t) => (buf[t] | 0) > 0);
  const hasType = Object.prototype.hasOwnProperty.call(buf, itemTypeId);
  if (!hasType && existingTypes.length >= BUFFER_MAX_TYPES) return 0;
  const current = Math.max(0, Number(buf[itemTypeId]) || 0);
  const cap = Math.max(1, BUFFER_MAX_PER_TYPE | 0);
  const add = Math.max(0, Math.min(cap - current, safeAmount));
  if (add <= 0) return 0;
  buf[itemTypeId] = current + add;
  return add;
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

function slotsToBuffer(slots, buf) {
  const next = {};
  for (const it of slots) {
    if (!it || !it.typeId) continue;
    const cur = Math.max(0, Number(next[it.typeId]) || 0);
    next[it.typeId] = cur + (it.amount | 0);
  }
  for (const key of Object.keys(buf)) delete buf[key];
  for (const [typeId, count] of Object.entries(next)) buf[typeId] = count;
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
      slotsToBuffer(slots, buf);
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
  if (!block || block.typeId !== HOPPER_ID) return null;
  let resolvedKey = key;
  if (!resolvedKey) {
    const dimId = block.dimension?.id;
    const loc = block.location;
    if (dimId && loc) resolvedKey = makeKey(dimId, loc.x, loc.y, loc.z);
  }
  if (!resolvedKey) return null;
  return getVirtualContainerForKey(resolvedKey);
}

export {
  HOPPER_ID,
  bufferByKey,
  getBufferForKey,
  getBufferSnapshot,
  tryInsertIntoBuffer,
  getVirtualContainerForBlock,
  getBufferSnapshot as getVacuumHopperBufferSnapshot,
};
