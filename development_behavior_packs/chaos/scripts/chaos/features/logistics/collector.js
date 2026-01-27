// scripts/chaos/features/logistics/collector.js
import { world, system, ItemStack } from "@minecraft/server";
import {
  DP_COLLECTOR_REGISTRY,
  DP_COLLECTOR_STATE,
} from "../../core/constants.js";
import { key as makeKey, parseKey, canonicalizePrismKey } from "./keys.js";
import { getAllAdjacentInventories, tryInsertAmountForContainerWithRemainder } from "./util/inventoryAdapter.js";
import { getInventoryMutationGuard } from "./util/inventoryMutationGuard.js";
import { safeJsonParse, safeJsonStringify } from "./persistence/serializers.js";
import { isPrismBlock, LENS_ID, MAX_BEAM_LEN, isBeamId } from "./config.js";
import { beamAxisMatchesDir } from "./network/beams/axis.js";
import { lensAllowsDir } from "./util/lens.js";
import { queueFxParticle } from "../../fx/fx.js";
import { getFluxValueForItem } from "../../crystallizer.js";
import {
  COLLECTOR_ID,
  stateByKey,
  getCollectorState,
  setCollectorState,
  filterAcceptsItem,
  getBufferForKey,
  getBufferSnapshot,
  getBufferTotals,
  canInsertIntoBuffer,
  tryInsertIntoBuffer,
  removeFromBuffer,
  getVirtualContainerForBlock,
  setCollectorNetworkEnabled,
  isCollectorNetworkEnabled,
  markCollectorFail,
  setCollectorReadyState,
  BUFFER_MAX_SLOTS,
} from "./collectorState.js";

const TICK_INTERVAL = 2;
const SCAN_RADIUS = 8.0;
const SUCTION_RADIUS = 1.1;
const PULL_STRENGTH = 0.5;
const MAX_COLLECTORS_PER_TICK = 6;
const MAX_ENTITIES_PER_COLLECTOR = 6;
const SCAN_INTERVAL_TICKS = 6;
const OUTPUT_ITEMS_PER_TICK = 16;
const ANCHOR_SCAN_INTERVAL_TICKS = 20;
const ANCHOR_RANGE = MAX_BEAM_LEN;
const OUTPUT_MODE = "INVENTORY_FIRST";

const collectorKeys = new Set();
const nextScanByKey = new Map();
const nextAnchorScanByKey = new Map();
const nextFxByKey = new Map();
const nextFailFxByKey = new Map();
const anchorToCollectors = new Map();

let registryDirty = false;
let stateDirty = false;
let registryAvailable = false;

function markStateDirty() {
  stateDirty = true;
}

export function markCollectorStateDirty() {
  markStateDirty();
}

function noteFail(key, reason) {
  markCollectorFail(key, reason);
  markStateDirty();
}

function safePlaySoundAt(dimension, soundId, location) {
  try {
    if (!soundId || !dimension || !location) return;
    dimension.playSound(soundId, location);
  } catch {
    // ignore
  }
}

function registerWorldDP(e) {
  try {
    e.propertyRegistry.registerWorldDynamicProperties({
      [DP_COLLECTOR_REGISTRY]: { type: "string", maxLength: 200000 },
      [DP_COLLECTOR_STATE]: { type: "string", maxLength: 200000 },
    });
    registryAvailable = true;
  } catch {
    try {
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_COLLECTOR_REGISTRY, 200000)
      );
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_COLLECTOR_STATE, 200000)
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
        loadState();
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
    const raw = world.getDynamicProperty(DP_COLLECTOR_REGISTRY);
    const parsed = safeJsonParse(raw, null);
    if (!Array.isArray(parsed)) return;
    collectorKeys.clear();
    for (const k of parsed) {
      const key = canonicalizePrismKey(k);
      if (key) collectorKeys.add(key);
    }
    registryAvailable = true;
  } catch {
    // ignore
  }
}

function saveRegistry() {
  if (!registryDirty) return;
  try {
    const raw = safeJsonStringify(Array.from(collectorKeys.values()));
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_COLLECTOR_REGISTRY, raw);
    registryDirty = false;
    registryAvailable = true;
  } catch {
    // ignore
  }
}

function normalizeStateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.buffer && typeof entry.buffer === "object") return entry;
  const hasKnownFields = (
    "filters" in entry ||
    "charge" in entry ||
    "counters" in entry ||
    "anchorKey" in entry
  );
  if (!hasKnownFields) {
    return { buffer: entry };
  }
  return entry;
}

function loadState() {
  try {
    const parsed = safeJsonParse(world.getDynamicProperty(DP_COLLECTOR_STATE), null);
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed)) {
      if (!key) continue;
      const canonical = canonicalizePrismKey(key) || key;
      const normalized = normalizeStateEntry(value) || {};
      const base = getCollectorState(canonical);
      if (!base) continue;
      base.buffer = normalized.buffer && typeof normalized.buffer === "object" ? normalized.buffer : (base.buffer || {});
      base.filters = Array.isArray(normalized.filters) ? normalized.filters : (base.filters || []);
      base.charge = Number.isFinite(normalized.charge) ? (normalized.charge | 0) : (base.charge | 0);
      base.maxCharge = Number.isFinite(normalized.maxCharge) ? (normalized.maxCharge | 0) : (base.maxCharge | 0);
      if ((base.charge | 0) > (base.maxCharge | 0)) base.charge = base.maxCharge | 0;
      base.anchorKey = normalized.anchorKey || base.anchorKey || null;
      if (normalized.counters && typeof normalized.counters === "object") {
        base.counters = {
          vacuumed: Math.max(0, normalized.counters.vacuumed | 0),
          insertedInv: Math.max(0, normalized.counters.insertedInv | 0),
          handedNetwork: Math.max(0, normalized.counters.handedNetwork | 0),
        };
      }
      if (normalized.failCounts && typeof normalized.failCounts === "object") {
        base.failCounts = { ...normalized.failCounts };
      }
      setCollectorState(canonical, base);
      collectorKeys.add(canonical);
    }
  } catch {
    // ignore
  }
}

function saveState() {
  if (!stateDirty) return;
  try {
    const obj = {};
    for (const [key, st] of stateByKey.entries()) {
      if (!st || typeof st !== "object") continue;
      obj[key] = {
        buffer: st.buffer || {},
        filters: Array.isArray(st.filters) ? st.filters : [],
        charge: Math.max(0, st.charge | 0),
        maxCharge: Math.max(1, st.maxCharge | 0),
        anchorKey: st.anchorKey || null,
        counters: {
          vacuumed: Math.max(0, st.counters?.vacuumed | 0),
          insertedInv: Math.max(0, st.counters?.insertedInv | 0),
          handedNetwork: Math.max(0, st.counters?.handedNetwork | 0),
        },
        failCounts: st.failCounts || {},
      };
    }
    const raw = safeJsonStringify(obj);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_COLLECTOR_STATE, raw);
    stateDirty = false;
  } catch {
    // ignore
  }
}

function addCollectorKey(key) {
  if (!key || collectorKeys.has(key)) return;
  collectorKeys.add(key);
  registryDirty = true;
  getCollectorState(key);
  markStateDirty();
}

function removeCollectorKey(key) {
  if (!key) return;
  collectorKeys.delete(key);
  nextScanByKey.delete(key);
  nextAnchorScanByKey.delete(key);
  nextFxByKey.delete(key);
  nextFailFxByKey.delete(key);
  const st = getCollectorState(key);
  if (st?.anchorKey) removeAnchorMapping(st.anchorKey, key);
  stateByKey.delete(key);
  registryDirty = true;
  markStateDirty();
}

function addAnchorMapping(anchorKey, collectorKey) {
  if (!anchorKey || !collectorKey) return;
  if (!anchorToCollectors.has(anchorKey)) anchorToCollectors.set(anchorKey, new Set());
  anchorToCollectors.get(anchorKey).add(collectorKey);
}

function removeAnchorMapping(anchorKey, collectorKey) {
  const set = anchorToCollectors.get(anchorKey);
  if (!set) return;
  set.delete(collectorKey);
  if (set.size === 0) anchorToCollectors.delete(anchorKey);
}

function syncAnchorMapping(key, prevAnchor, prevEnabled, nextAnchor, nextEnabled) {
  if (prevAnchor && prevEnabled) removeAnchorMapping(prevAnchor, key);
  if (nextAnchor && nextEnabled) addAnchorMapping(nextAnchor, key);
}

function isCollectorBlock(block) {
  return block?.typeId === COLLECTOR_ID;
}

function shouldScan(key, nowTick) {
  const next = nextScanByKey.get(key) || 0;
  if (nowTick < next) return false;
  nextScanByKey.set(key, nowTick + SCAN_INTERVAL_TICKS);
  return true;
}

function shouldRescanAnchor(key, nowTick) {
  const next = nextAnchorScanByKey.get(key) || 0;
  if (nowTick < next) return false;
  nextAnchorScanByKey.set(key, nowTick + ANCHOR_SCAN_INTERVAL_TICKS);
  return true;
}

function findAnchorPrism(block, dim, range) {
  if (!block || !dim) return null;
  const loc = block.location;
  if (!loc) return null;
  const base = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
  ];
  const max = Math.max(1, Number(range) || MAX_BEAM_LEN);
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const dir of dirs) {
    for (let i = 1; i <= max; i++) {
      const pos = { x: base.x + dir.dx * i, y: base.y + dir.dy * i, z: base.z + dir.dz * i };
      const b = dim.getBlock(pos);
      if (!b) break;
      const id = b.typeId;
      if (id === "minecraft:air") continue;
      if (isBeamId(id)) {
        if (!beamAxisMatchesDir(b, dir.dx, dir.dy, dir.dz)) break;
        continue;
      }
      if (id === LENS_ID) {
        if (!lensAllowsDir(b, dir.dx, dir.dy, dir.dz)) break;
        continue;
      }
      if (isPrismBlock(b)) {
        if (i < bestDist) {
          bestDist = i;
          best = makeKey(dim.id, pos.x, pos.y, pos.z);
        }
        break;
      }
      break;
    }
  }

  return best;
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

function emitCollectorFx(dim, loc, kind, nowTick, cooldownTicks = 10) {
  if (!dim || !loc) return;
  const key = `${loc.x},${loc.y},${loc.z}`;
  const map = kind === "fail" ? nextFailFxByKey : nextFxByKey;
  const next = map.get(key) || 0;
  if (nowTick < next) return;
  map.set(key, nowTick + Math.max(1, cooldownTicks | 0));

  if (kind === "success") {
    queueFxParticle(dim, "chaos:block_burst_pop", { x: loc.x + 0.5, y: loc.y + 0.7, z: loc.z + 0.5 });
    safePlaySoundAt(dim, "random.click", loc);
  } else if (kind === "full") {
    queueFxParticle(dim, "chaos:block_burst_puff", { x: loc.x + 0.5, y: loc.y + 0.6, z: loc.z + 0.5 });
    safePlaySoundAt(dim, "random.anvil_land", loc);
  } else if (kind === "no_charge") {
    queueFxParticle(dim, "chaos:link_input_charge", { x: loc.x + 0.5, y: loc.y + 0.6, z: loc.z + 0.5 });
    safePlaySoundAt(dim, "random.fizz", loc);
  }
}

function updateChargeIndicator(dim, loc, st, nowTick) {
  if (!dim || !loc || !st) return;
  const key = `${loc.x},${loc.y},${loc.z}`;
  const next = nextFxByKey.get(key) || 0;
  if (nowTick < next) return;
  nextFxByKey.set(key, nowTick + 20);

  const particle = (st.charge | 0) > 0 ? "chaos:link_input_charge" : "chaos:block_burst_puff";
  queueFxParticle(dim, particle, { x: loc.x + 0.5, y: loc.y + 0.8, z: loc.z + 0.5 });
}

function updateCollectorPoweredState(block, st, forceUnpowered = false) {
  if (!block || !st) return;
  const desired = forceUnpowered ? 0 : ((st.charge | 0) > 0 ? 1 : 0);
  try {
    const current = block.permutation?.getState?.("chaos:collector_powered");
    if (current === desired) return;
    block.setPermutation(block.permutation.withState("chaos:collector_powered", desired));
  } catch {
    // ignore
  }
}

function getRedstonePower(block) {
  if (!block) return 0;
  try {
    if (typeof block.getRedstonePower === "function") return block.getRedstonePower() | 0;
  } catch {
    // ignore
  }
  try {
    const comp = block.getComponent?.("minecraft:redstone_power");
    const power = comp?.power;
    if (Number.isFinite(power)) return power | 0;
  } catch {
    // ignore
  }
  return 0;
}

function processCollector(key, nowTick) {
  const parsed = parseKey(key);
  if (!parsed) {
    removeCollectorKey(key);
    return;
  }
  const dim = world.getDimension(parsed.dimId);
  if (!dim) return;
  const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  if (!isCollectorBlock(block)) {
    removeCollectorKey(key);
    return;
  }

  const st = getCollectorState(key);
  if (!st) return;

  if (shouldRescanAnchor(key, nowTick)) {
    const prevAnchor = st.anchorKey || null;
    const anchorKey = findAnchorPrism(block, dim, ANCHOR_RANGE);
    st.anchorKey = anchorKey || null;
    st.anchorValid = !!st.anchorKey;
    if (prevAnchor !== st.anchorKey) markStateDirty();
  }

  const redstonePower = getRedstonePower(block);
  const redstoneDisabled = redstonePower > 0;
  updateCollectorPoweredState(block, st, redstoneDisabled);
  if (redstoneDisabled) {
    const prevEnabled = isCollectorNetworkEnabled(key);
    if (prevEnabled) {
      syncAnchorMapping(key, st.anchorKey, prevEnabled, st.anchorKey, false);
      setCollectorNetworkEnabled(key, false);
    }
    setCollectorReadyState(key, false, "REDSTONE_DISABLED");
    return;
  }

  updateChargeIndicator(dim, block.location, st, nowTick);

  const hasAnchor = !!st.anchorKey && !!st.anchorValid;
  const prevEnabled = isCollectorNetworkEnabled(key);
  const nextEnabled = hasAnchor;
  if (prevEnabled !== nextEnabled) {
    syncAnchorMapping(key, st.anchorKey, prevEnabled, st.anchorKey, nextEnabled);
    setCollectorNetworkEnabled(key, nextEnabled);
  }

  if (!shouldScan(key, nowTick)) return;

  const inventories = getAllAdjacentInventories(block, dim);
  const ctx = { nowTick, cfg: { strictOrbsOnly: false } };
  const metaBase = { phase: "collector", tag: "output", prismKey: key };

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

  const buffer = getBufferForKey(key);
  const bufferTotals = getBufferTotals(buffer);
  const bufferFull = bufferTotals.slotsUsed >= BUFFER_MAX_SLOTS;

  let itemsProcessed = 0;
  let foundEntity = false;
  let foundAccepted = false;
  let foundRejected = false;

  const center = { x: parsed.x + 0.5, y: parsed.y + 0.5, z: parsed.z + 0.5 };
  for (const entity of entities) {
    if (itemsProcessed >= MAX_ENTITIES_PER_COLLECTOR) break;
    const comp = entity?.getComponent?.("minecraft:item");
    const stack = comp?.itemStack;
    if (!stack || !stack.typeId) continue;
    const amount = stack.amount | 0;
    if (amount <= 0) continue;

    foundEntity = true;

    const loc = entity.location;
    if (!loc) continue;
    const dx = center.x - loc.x;
    const dy = center.y - loc.y;
    const dz = center.z - loc.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    const accepted = filterAcceptsItem(st, stack.typeId);
    if (!accepted) {
      foundRejected = true;
      if (distSq <= (SUCTION_RADIUS * SUCTION_RADIUS)) {
        noteFail(key, "FILTER_REJECT");
      }
      continue;
    }
    foundAccepted = true;

    if (distSq > (SUCTION_RADIUS * SUCTION_RADIUS)) {
      const canPull =
        (st.charge | 0) >= amount &&
        !bufferFull &&
        canInsertIntoBuffer(buffer, stack.typeId, amount);
      if (canPull) {
        try {
          const dist = Math.sqrt(distSq) || 0.0001;
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;
          entity.applyImpulse?.({ x: nx * PULL_STRENGTH, y: ny * PULL_STRENGTH, z: nz * PULL_STRENGTH });
        } catch {
          // ignore
        }
      }
      continue;
    }

    if ((st.charge | 0) < amount) {
      noteFail(key, "NO_CHARGE");
      emitCollectorFx(dim, block.location, "no_charge", nowTick, 20);
      continue;
    }

    if (!tryInsertIntoBuffer(key, stack.typeId, amount)) {
      noteFail(key, "BUFFER_FULL");
      emitCollectorFx(dim, block.location, "full", nowTick, 20);
      continue;
    }

    st.charge = Math.max(0, (st.charge | 0) - amount);
    st.counters.vacuumed = Math.max(0, (st.counters.vacuumed | 0) + amount);
    updateItemEntity(entity, comp, stack, 0);
    itemsProcessed++;
    markStateDirty();
    emitCollectorFx(dim, block.location, "success", nowTick, 6);
  }

  let outputBudget = Math.max(0, OUTPUT_ITEMS_PER_TICK | 0);
  if (inventories.length > 0 && outputBudget > 0) {
    for (const [typeId, count] of Object.entries(buffer)) {
      if (outputBudget <= 0) break;
      const amt = Math.max(0, Number(count) || 0);
      if (amt <= 0) {
        delete buffer[typeId];
        continue;
      }
      const want = Math.min(amt, outputBudget);
      const inserted = tryInsertIntoInventories(ctx, inventories, typeId, want, metaBase);
      if (inserted > 0) {
        const removed = removeFromBuffer(key, typeId, inserted);
        st.counters.insertedInv = Math.max(0, (st.counters.insertedInv | 0) + removed);
        outputBudget -= removed;
        markStateDirty();
      }
    }
  }

  const totalsAfter = getBufferTotals(buffer);
  const hasBufferItems = totalsAfter.total > 0;

  if (hasBufferItems && inventories.length === 0 && !hasAnchor) {
    noteFail(key, "NO_TARGET");
  }

  let ready = true;
  let reason = null;
  if ((st.charge | 0) <= 0) {
    ready = false;
    reason = "NO_CHARGE";
  } else if (totalsAfter.slotsUsed >= BUFFER_MAX_SLOTS) {
    ready = false;
    reason = "BUFFER_FULL";
  } else if (!foundEntity) {
    ready = false;
    reason = "NO_TARGET";
  } else if (foundEntity && !foundAccepted && foundRejected) {
    ready = false;
    reason = "FILTER_REJECT";
  }
  setCollectorReadyState(key, ready, reason);
}

function dropBufferOnBreak(block, key) {
  const buf = getBufferForKey(key);
  const loc = block.location;
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
}

export function getCollectorInventoriesForPrism(prismKey) {
  if (!prismKey) return [];
  const set = anchorToCollectors.get(prismKey);
  if (!set || set.size === 0) return [];
  const out = [];
  for (const collectorKey of set.values()) {
    const parsed = parseKey(collectorKey);
    if (!parsed) continue;
    const dim = world.getDimension(parsed.dimId);
    if (!dim) continue;
    const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!block || block.typeId !== COLLECTOR_ID) continue;
    const container = getVirtualContainerForBlock(block, collectorKey);
    if (!container) continue;
    out.push({ block, container, dim, pos: block.location, source: "collector", collectorKey });
  }
  return out;
}

export function addCollectorChargeForBlock(block, itemTypeId, amount) {
  try {
    if (!block || block.typeId !== COLLECTOR_ID) return 0;
    const dimId = block.dimension?.id;
    const loc = block.location;
    if (!dimId || !loc) return 0;
    const key = makeKey(dimId, loc.x, loc.y, loc.z);
    const st = getCollectorState(key);
    if (!st) return 0;
    const value = getFluxValueForItem(itemTypeId);
    if (value <= 0) return 0;
    const add = value * Math.max(1, amount | 0);
    const maxCharge = Math.max(1, st.maxCharge | 0);
    const next = Math.min(maxCharge, (st.charge | 0) + add);
    const added = Math.max(0, next - (st.charge | 0));
    st.charge = next;
    markStateDirty();
    return added;
  } catch {
    return 0;
  }
}

export function startCollectorSystem() {
  try {
    loadRegistry();
    loadState();
  } catch {
    // ignore
  }

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const block = ev?.block;
      if (!block || block.typeId !== COLLECTOR_ID) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (key) addCollectorKey(key);
    } catch {
      // ignore
    }
  });

  try {
    world.afterEvents.entityPlaceBlock.subscribe((ev) => {
      try {
        const block = ev?.block;
        if (!block || block.typeId !== COLLECTOR_ID) return;
        const dimId = block.dimension?.id;
        const loc = block.location;
        if (!dimId || !loc) return;
        const key = makeKey(dimId, loc.x, loc.y, loc.z);
        if (key) addCollectorKey(key);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    world.afterEvents.blockPlace.subscribe((ev) => {
      try {
        const block = ev?.block;
        if (!block || block.typeId !== COLLECTOR_ID) return;
        const dimId = block.dimension?.id;
        const loc = block.location;
        if (!dimId || !loc) return;
        const key = makeKey(dimId, loc.x, loc.y, loc.z);
        if (key) addCollectorKey(key);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev?.brokenBlockPermutation?.type?.id;
      if (brokenId !== COLLECTOR_ID) return;
      const block = ev?.block;
      if (!block) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (!key) return;
      dropBufferOnBreak(block, key);
      removeCollectorKey(key);
    } catch {
      // ignore
    }
  });

  system.runInterval(() => {
    const nowTick = system.currentTick | 0;
    saveRegistry();
    saveState();

    if (collectorKeys.size === 0) return;
    const keys = Array.from(collectorKeys.values());
    const budget = Math.min(MAX_COLLECTORS_PER_TICK, keys.length);
    let index = nowTick % keys.length;

    for (let i = 0; i < budget; i++) {
      const k = keys[index % keys.length];
      index++;
      if (k) processCollector(k, nowTick);
    }
  }, TICK_INTERVAL);
}

export function getCollectorBufferSnapshot(key) {
  return getBufferSnapshot(key);
}

export function getCollectorOutputMode() {
  return OUTPUT_MODE;
}

export function getCollectorFilterMode() {
  return "EMPTY_ACCEPTS_ALL";
}

export function getCollectorStateForInsight(key) {
  return getCollectorState(key);
}

export function getCollectorAdjacencyInfo(block) {
  if (!block) return { count: 0, firstType: "none" };
  const dim = block.dimension;
  const inventories = getAllAdjacentInventories(block, dim);
  const count = inventories.length | 0;
  const firstType = inventories[0]?.block?.typeId || "none";
  return { count, firstType };
}

export function getCollectorAnchorStatus(key) {
  const st = getCollectorState(key);
  if (!st) return { status: "NONE", anchorKey: null };
  if (!st.anchorKey) return { status: "NONE", anchorKey: null };
  return { status: st.anchorValid ? "CONNECTED" : "INVALID", anchorKey: st.anchorKey };
}

export function getCollectorFiltersForInsight(key) {
  const st = getCollectorState(key);
  return Array.isArray(st?.filters) ? st.filters.slice() : [];
}
