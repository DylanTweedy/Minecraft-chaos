// scripts/chaos/features/logistics/vacuumHopper.js
import { world, system, ItemStack } from "@minecraft/server";
import { DP_VACUUM_HOPPERS, DP_VACUUM_HOPPER_BUFFERS } from "../../core/constants.js";
import { key as makeKey, parseKey, canonicalizePrismKey } from "./keys.js";
import { getAllAdjacentInventories, tryInsertAmountForContainerWithRemainder } from "./util/inventoryAdapter.js";
import { getInventoryMutationGuard } from "./util/inventoryMutationGuard.js";
import {
  HOPPER_ID,
  bufferByKey,
  getBufferForKey,
  tryInsertIntoBuffer,
} from "./vacuumBuffer.js";

const TICK_INTERVAL = 2;
const SCAN_RADIUS = 8.0;
const INSERT_RADIUS = 1.1;
const PULL_STRENGTH = 0.5;
const MAX_HOPPERS_PER_TICK = 6;
const MAX_ITEMS_PER_HOPPER = 8;
const HOPPER_SCAN_INTERVAL_TICKS = 6;
const hopperKeys = new Set();
const nextScanByKey = new Map();
let dirty = false;
let registryAvailable = false;

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function registerWorldDP(e) {
  try {
    e.propertyRegistry.registerWorldDynamicProperties({
      [DP_VACUUM_HOPPERS]: { type: "string", maxLength: 200000 },
      [DP_VACUUM_HOPPER_BUFFERS]: { type: "string", maxLength: 200000 },
    });
    registryAvailable = true;
  } catch {
    try {
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_VACUUM_HOPPERS, 200000)
      );
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_VACUUM_HOPPER_BUFFERS, 200000)
      );
      registryAvailable = true;
    } catch {
      registryAvailable = false;
    }
  }
}

try {
  const hook = world?.afterEvents?.worldInitialize;
  if (hook?.subscribe) {
    hook.subscribe((e) => {
      try {
        registerWorldDP(e);
        loadRegistry();
      } catch {
        // ignore
      }
    });
  }
} catch {
  // ignore
}

function loadRegistry() {
  try {
    const raw = world.getDynamicProperty(DP_VACUUM_HOPPERS);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return;
    hopperKeys.clear();
    for (const k of parsed) {
      const key = canonicalizePrismKey(k);
      if (key) hopperKeys.add(key);
    }
    registryAvailable = true;
  } catch {
    // ignore
  }
}

function saveRegistry() {
  if (!dirty) return;
  try {
    const raw = safeJsonStringify(Array.from(hopperKeys.values()));
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_VACUUM_HOPPERS, raw);
    dirty = false;
    registryAvailable = true;
  } catch {
    // ignore
  }
}

function loadBuffers() {
  try {
    const raw = world.getDynamicProperty(DP_VACUUM_HOPPER_BUFFERS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return;
    bufferByKey.clear();
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== "object") continue;
      bufferByKey.set(key, value);
    }
  } catch {
    // ignore
  }
}

function saveBuffers() {
  try {
    const obj = {};
    for (const [key, items] of bufferByKey.entries()) {
      if (!items || typeof items !== "object") continue;
      obj[key] = items;
    }
    const raw = safeJsonStringify(obj);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_VACUUM_HOPPER_BUFFERS, raw);
  } catch {
    // ignore
  }
}


function addHopperKey(key) {
  if (!key || hopperKeys.has(key)) return;
  hopperKeys.add(key);
  dirty = true;
}

function removeHopperKey(key) {
  if (!key || !hopperKeys.has(key)) return;
  hopperKeys.delete(key);
  nextScanByKey.delete(key);
  dirty = true;
}

function isHopperBlock(block) {
  return block?.typeId === HOPPER_ID;
}

function shouldScan(key, nowTick) {
  const next = nextScanByKey.get(key) || 0;
  if (nowTick < next) return false;
  nextScanByKey.set(key, nowTick + HOPPER_SCAN_INTERVAL_TICKS);
  return true;
}

function tryInsertIntoInventories(ctx, inventories, itemTypeId, amount, metaBase) {
  let remaining = Math.max(0, amount | 0);
  if (remaining <= 0) return 0;
  const guard = getInventoryMutationGuard();

  for (const inv of inventories) {
    if (!inv?.container) continue;
    const meta = { ...metaBase, containerKey: null };
    try {
      meta.containerKey = inv?.block ? makeKey(inv.block.dimension?.id, inv.block.location.x, inv.block.location.y, inv.block.location.z) : null;
    } catch {
      meta.containerKey = null;
    }

    guard.beginOrbSettlement(ctx, meta);
    const res = tryInsertAmountForContainerWithRemainder(inv, itemTypeId, remaining, { ctx, ...meta });
    guard.endOrbSettlement();

    remaining -= res.inserted | 0;
    if (remaining <= 0) break;
  }

  return Math.max(0, amount - remaining);
}

function updateItemEntity(entity, comp, stack, remaining) {
  try {
    if (remaining <= 0) {
      if (typeof entity?.remove === "function") entity.remove();
      else entity?.triggerEvent?.("minecraft:despawn");
      return true;
    }
    stack.amount = remaining;
    comp.itemStack = stack;
    return true;
  } catch {
    return false;
  }
}

function processHopper(key, nowTick) {
  const parsed = parseKey(key);
  if (!parsed) {
    removeHopperKey(key);
    return;
  }
  const dim = world.getDimension(parsed.dimId);
  if (!dim) return;
  const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  if (!isHopperBlock(block)) {
    removeHopperKey(key);
    return;
  }

  if (!shouldScan(key, nowTick)) return;

  const inventories = getAllAdjacentInventories(block, dim);
  const ctx = { nowTick, cfg: { strictOrbsOnly: false } };
  const metaBase = { phase: "vacuum_hopper", tag: "suction", prismKey: key };

  let entities = [];
  try {
    entities = dim.getEntities({
      type: "minecraft:item",
      location: { x: parsed.x + 0.5, y: parsed.y + 0.5, z: parsed.z + 0.5 },
      maxDistance: SCAN_RADIUS,
    });
  } catch {
    entities = [];
  }

  let itemsProcessed = 0;
  const center = { x: parsed.x + 0.5, y: parsed.y + 0.5, z: parsed.z + 0.5 };
  for (const entity of entities) {
    if (itemsProcessed >= MAX_ITEMS_PER_HOPPER) break;
    const comp = entity?.getComponent?.("minecraft:item");
    const stack = comp?.itemStack;
    if (!stack || !stack.typeId) continue;

    const loc = entity.location;
    if (!loc) continue;
    const dx = center.x - loc.x;
    const dy = center.y - loc.y;
    const dz = center.z - loc.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq > (INSERT_RADIUS * INSERT_RADIUS)) {
      try {
        const dist = Math.sqrt(distSq) || 0.0001;
        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        entity.applyImpulse?.({ x: nx * PULL_STRENGTH, y: ny * PULL_STRENGTH, z: nz * PULL_STRENGTH });
      } catch {
        // ignore
      }
      continue;
    }

    let remaining = stack.amount | 0;
    if (remaining <= 0) continue;

    const insertedAdj = tryInsertIntoInventories(ctx, inventories, stack.typeId, remaining, metaBase);
    remaining -= insertedAdj;

    if (remaining > 0) {
      const buffered = tryInsertIntoBuffer(key, stack.typeId, remaining);
      remaining -= buffered;
    }

    if (remaining < (stack.amount | 0)) {
      updateItemEntity(entity, comp, stack, remaining);
      itemsProcessed++;
    }
  }

  // Try to flush buffer into adjacent inventories each scan
  if (inventories.length > 0) {
    const buf = getBufferForKey(key);
    for (const [typeId, count] of Object.entries(buf)) {
      const amt = Math.max(0, Number(count) || 0);
      if (amt <= 0) {
        delete buf[typeId];
        continue;
      }
      const inserted = tryInsertIntoInventories(ctx, inventories, typeId, amt, metaBase);
      if (inserted > 0) {
        const next = Math.max(0, amt - inserted);
        if (next > 0) buf[typeId] = next;
        else delete buf[typeId];
      }
    }
  }
}

export function startVacuumHopperSystem() {
  try {
    loadRegistry();
    loadBuffers();
  } catch {
    // ignore
  }

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const block = ev?.block;
      if (!block || block.typeId !== HOPPER_ID) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (key) addHopperKey(key);
    } catch {
      // ignore
    }
  });

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev?.brokenBlockPermutation?.type?.id;
      if (brokenId !== HOPPER_ID) return;
      const block = ev?.block;
      if (!block) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (key) {
        const buf = getBufferForKey(key);
        const dim = block.dimension;
        const dropLoc = { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
        for (const [typeId, count] of Object.entries(buf)) {
          const amt = Math.max(0, Number(count) || 0);
          if (amt <= 0) continue;
          try {
            const stack = new ItemStack(typeId, Math.min(amt, 64));
            let remaining = amt;
            while (remaining > 0) {
              const size = Math.min(remaining, stack.maxAmount || 64);
              dim.spawnItem(new ItemStack(typeId, size), dropLoc);
              remaining -= size;
            }
          } catch {
            // ignore
          }
        }
        bufferByKey.delete(key);
        removeHopperKey(key);
      }
    } catch {
      // ignore
    }
  });

  system.runInterval(() => {
    const nowTick = system.currentTick | 0;
    saveRegistry();
    saveBuffers();

    if (hopperKeys.size === 0) return;
    const keys = Array.from(hopperKeys.values());
    const budget = Math.min(MAX_HOPPERS_PER_TICK, keys.length);
    let index = nowTick % keys.length;

    for (let i = 0; i < budget; i++) {
      const k = keys[index % keys.length];
      index++;
      if (k) processHopper(k, nowTick);
    }
  }, TICK_INTERVAL);
}
