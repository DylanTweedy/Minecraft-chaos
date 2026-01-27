// scripts/chaos/features/transposer/transposerSystem.js
import { world, system } from "@minecraft/server";
import { key as makeKey, parseKey } from "../logistics/keys.js";
import { getFluxTier, isFluxTypeId } from "../../flux.js";
import {
  getLinkedKey,
  loadTransposerPairsFromWorldSafe,
  saveTransposerPairsIfDirty,
} from "./pairs.js";
import {
  addSharedCharge,
  getChargeLimits,
  getSharedStateKey,
  getSharedStateSnapshot,
  recordFailure,
  recordTeleport,
  spendSharedCharge,
} from "./state.js";

const TRANSPOSER_ID = "chaos:teleporter";
const TRANSPOSER_COOLDOWN_TAG = "chaos:transposer_cooldown";
const TRANSPOSER_EXIT_TAG = "chaos:transposer_exit_required";
const TRANSPOSER_REGISTRY = "chaos:transposer_registry_v1_json";
const TRANSPOSER_STATE_KEY = "chaos:transposer_state";

const STATE_UNLINKED = 0;
const STATE_LINKED_UNPOWERED = 1;
const STATE_CHARGED = 2;
const STATE_OVERCHARGED = 3;

const TICK_INTERVAL = 2;
const MAX_TRANSPOSERS_PER_TICK = 8;
const ENTITY_SCAN_RADIUS = 1.2;
const MAX_ENTITIES_PER_TRANSPOSER = 8;
const CHARGE_SCAN_RADIUS = 1.1;
const TRANSPOSER_SCAN_INTERVAL_TICKS = 4;

const COOLDOWN_TICKS_ENTITY = 16;
const COOLDOWN_TICKS_ITEM = 8;

const SFX_SUCCESS = "mob.endermen.portal";
const SFX_FAIL = "random.click";
const SFX_UNPOWERED = "random.anvil_land";

const FX_CHARGED = "minecraft:portal";
const FX_UNCHARGED = "minecraft:basic_smoke_particle";
const FX_FAIL = "minecraft:basic_smoke_particle";

const transposerKeys = new Set();
const nextScanByKey = new Map();
const lastNotifyByPlayer = new Map(); // key -> tick
const lastFailFxByKey = new Map(); // key+reason -> tick
let registryAvailable = false;
let registryDirty = false;

function safeJsonParse(s, fallback) {
  try {
    if (typeof s !== "string" || !s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
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
  const maxLength = 200000;
  try {
    e.propertyRegistry.registerWorldDynamicProperties({
      [TRANSPOSER_REGISTRY]: { type: "string", maxLength },
    });
    registryAvailable = true;
  } catch {
    try {
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(TRANSPOSER_REGISTRY, maxLength)
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
    const raw = world.getDynamicProperty(TRANSPOSER_REGISTRY);
    const parsed = safeJsonParse(raw, []);
    if (!Array.isArray(parsed)) return;
    transposerKeys.clear();
    for (const k of parsed) {
      if (typeof k === "string" && k.length) transposerKeys.add(k);
    }
    registryAvailable = true;
  } catch {
    // ignore
  }
}

function saveRegistry() {
  if (!registryDirty || !registryAvailable) return;
  try {
    const raw = safeJsonStringify(Array.from(transposerKeys.values()));
    if (typeof raw !== "string") return;
    world.setDynamicProperty(TRANSPOSER_REGISTRY, raw);
    registryDirty = false;
  } catch {
    // ignore
  }
}

function addTransposerKey(key) {
  if (!key || transposerKeys.has(key)) return;
  transposerKeys.add(key);
  registryDirty = true;
}

function removeTransposerKey(key) {
  if (!key || !transposerKeys.has(key)) return;
  transposerKeys.delete(key);
  nextScanByKey.delete(key);
  registryDirty = true;
}

function isTransposerBlock(block) {
  return block?.typeId === TRANSPOSER_ID;
}

function shouldScan(key, nowTick) {
  const next = nextScanByKey.get(key) || 0;
  if (nowTick < next) return false;
  nextScanByKey.set(key, nowTick + TRANSPOSER_SCAN_INTERVAL_TICKS);
  return true;
}

function isAirBlock(block) {
  try {
    const id = block?.typeId || "";
    return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";
  } catch {
    return true;
  }
}

function safePlaySoundAt(dim, soundId, location) {
  try {
    if (!dim || !soundId || !location) return;
    if (typeof dim.playSound === "function") dim.playSound(soundId, location);
  } catch {
    // ignore
  }
}

function safeSpawnParticle(dim, particleId, location) {
  try {
    if (!dim || !particleId || !location) return;
    dim.spawnParticle(particleId, location);
  } catch {
    // ignore
  }
}

function resolveTeleportLocation(dim, parsed) {
  if (!dim || !parsed) return null;
  const base = { x: parsed.x, y: parsed.y, z: parsed.z };
  const above = dim.getBlock({ x: base.x, y: base.y + 1, z: base.z });
  const above2 = dim.getBlock({ x: base.x, y: base.y + 2, z: base.z });
  if (isAirBlock(above)) return { x: base.x + 0.5, y: base.y + 1.1, z: base.z + 0.5 };
  if (isAirBlock(above2)) return { x: base.x + 0.5, y: base.y + 2.1, z: base.z + 0.5 };
  return { x: base.x + 0.5, y: base.y + 1.1, z: base.z + 0.5 };
}

function setTransposerState(block, state) {
  try {
    const perm = block?.permutation;
    if (!perm) return;
    const current = perm.getState(TRANSPOSER_STATE_KEY);
    if (current === state) return;
    block.setPermutation(perm.withState(TRANSPOSER_STATE_KEY, state));
  } catch {
    // ignore
  }
}

function playTeleportFxStart(dim, loc) {
  safePlaySoundAt(dim, "entity.ender_pearl.throw", loc);
  safeSpawnParticle(dim, FX_CHARGED, loc);
}

function playTeleportFxEnd(dim, loc) {
  safePlaySoundAt(dim, SFX_SUCCESS, loc);
  safeSpawnParticle(dim, FX_CHARGED, loc);
}

function notifyPlayer(player, reason, nowTick) {
  if (!player || player.typeId !== "minecraft:player") return;
  const key = `${player.id}:${reason}`;
  const last = lastNotifyByPlayer.get(key) | 0;
  if ((nowTick | 0) - last < 20) return;
  lastNotifyByPlayer.set(key, nowTick | 0);
  try {
    if (reason === "NO_LINK") player.sendMessage("Transposer is unlinked.");
    else if (reason === "NO_CHARGE") player.sendMessage("Transposer lacks flux charge.");
    else if (reason === "COOLDOWN") player.sendMessage("Transposer cooldown active.");
    else if (reason === "DEST_INVALID") player.sendMessage("Transposer link target missing.");
  } catch {
    // ignore
  }
}

function scheduleCooldownClear(entity, ticks) {
  try {
    entity.addTag?.(TRANSPOSER_COOLDOWN_TAG);
  } catch {
    // ignore
  }
  system.runTimeout(() => {
    try {
      entity.removeTag?.(TRANSPOSER_COOLDOWN_TAG);
    } catch {
      // ignore
    }
  }, Math.max(1, ticks | 0));
}

function applyFailFx(dim, loc, soundId) {
  safePlaySoundAt(dim, soundId || SFX_FAIL, loc);
  safeSpawnParticle(dim, FX_FAIL, loc);
}

function shouldPlayFailFx(key, reason, nowTick, cooldownTicks = 20) {
  const k = `${key}:${reason}`;
  const last = lastFailFxByKey.get(k) | 0;
  if ((nowTick | 0) - last < (cooldownTicks | 0)) return false;
  lastFailFxByKey.set(k, nowTick | 0);
  return true;
}

function isEntityOnTransposer(entity) {
  try {
    const dim = entity?.dimension;
    const loc = entity?.location;
    if (!dim || !loc) return false;
    const blockLoc = {
      x: Math.floor(loc.x),
      y: Math.floor(loc.y) - 1,
      z: Math.floor(loc.z),
    };
    const block = dim.getBlock(blockLoc);
    return block?.typeId === TRANSPOSER_ID;
  } catch {
    return false;
  }
}

function handleFluxCharge(dim, center, stateKey) {
  if (!dim || !center || !stateKey) return;
  let entities = [];
  try {
    entities = dim.getEntities({
      type: "minecraft:item",
      location: center,
      maxDistance: CHARGE_SCAN_RADIUS,
    });
  } catch {
    entities = [];
  }

  if (!entities.length) return;

  const { overchargeMax } = getChargeLimits();
  const snapshot = getSharedStateSnapshot(stateKey);
  const currentCharge = Math.max(0, snapshot?.charge | 0);
  let remainingCapacity = Math.max(0, (overchargeMax | 0) - currentCharge);
  if (remainingCapacity <= 0) return;

  for (const entity of entities) {
    if (remainingCapacity <= 0) break;
    const comp = entity?.getComponent?.("minecraft:item");
    const stack = comp?.itemStack;
    if (!stack || !stack.typeId || !isFluxTypeId(stack.typeId)) continue;
    const tier = Math.max(1, getFluxTier(stack.typeId) || 1);
    const available = stack.amount | 0;
    if (available <= 0) continue;
    const maxConsume = Math.floor(remainingCapacity / tier);
    if (maxConsume <= 0) continue;
    const consume = Math.min(available, maxConsume);
    const added = addSharedCharge(stateKey, consume * tier);
    if (added <= 0) continue;
    remainingCapacity = Math.max(0, remainingCapacity - added);
    try {
      if (consume >= available) {
        entity.remove?.();
      } else {
        stack.amount = available - consume;
        comp.itemStack = stack;
      }
      safeSpawnParticle(dim, "chaos:link_input_charge", center);
    } catch {
      // ignore
    }
  }
}

function getTeleportCandidates(dim, center) {
  let entities = [];
  try {
    entities = dim.getEntities({
      location: center,
      maxDistance: ENTITY_SCAN_RADIUS,
    });
  } catch {
    entities = [];
  }
  if (!entities.length) return [];

  const out = [];
  for (const entity of entities) {
    if (!entity || out.length >= MAX_ENTITIES_PER_TRANSPOSER) break;
    const typeId = entity.typeId;
    if (typeId === "minecraft:item") {
      const comp = entity?.getComponent?.("minecraft:item");
      const stack = comp?.itemStack;
      if (stack?.typeId && isFluxTypeId(stack.typeId)) continue;
      out.push({ entity, kind: "item" });
      continue;
    }
    if (typeId === "minecraft:player") {
      out.push({ entity, kind: "player" });
      continue;
    }
    const health = entity.getComponent?.("minecraft:health");
    if (health) out.push({ entity, kind: "entity" });
  }
  return out;
}

function resolveLinkedBlock(linkedKey) {
  const parsed = parseKey(linkedKey);
  if (!parsed) return null;
  const destDim = world.getDimension(parsed.dimId);
  if (!destDim) return { parsed, dim: null, block: null };
  const block = destDim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  return { parsed, dim: destDim, block };
}

function processTransposer(key, nowTick) {
  const parsed = parseKey(key);
  if (!parsed) {
    removeTransposerKey(key);
    return;
  }
  const dim = world.getDimension(parsed.dimId);
  if (!dim) return;
  const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  if (!isTransposerBlock(block)) {
    removeTransposerKey(key);
    return;
  }

  if (!shouldScan(key, nowTick)) return;

  const center = { x: parsed.x + 0.5, y: parsed.y + 0.5, z: parsed.z + 0.5 };
  const linkedKey = getLinkedKey(key);
  const stateKey = getSharedStateKey(key, linkedKey);

  if (stateKey) {
    handleFluxCharge(dim, center, stateKey);
  }

  const snapshot = stateKey ? getSharedStateSnapshot(stateKey) : null;
  let charge = Math.max(0, snapshot?.charge | 0);
  const chargeLimits = getChargeLimits();
  const maxCharge = Math.max(0, chargeLimits?.max | 0);

  let desiredState = STATE_UNLINKED;
  if (linkedKey) {
    if (charge > maxCharge) desiredState = STATE_OVERCHARGED;
    else if (charge > 0) desiredState = STATE_CHARGED;
    else desiredState = STATE_LINKED_UNPOWERED;
  }
  setTransposerState(block, desiredState);
  if (linkedKey) {
    addTransposerKey(linkedKey);
  }

  if (linkedKey && charge > 0) {
    safeSpawnParticle(dim, FX_CHARGED, center);
  } else if (linkedKey && charge <= 0) {
    safeSpawnParticle(dim, FX_UNCHARGED, center);
  }

  const candidates = getTeleportCandidates(dim, center);
  if (!candidates.length) return;

  const linkStatus = linkedKey ? resolveLinkedBlock(linkedKey) : null;
  const destValid = !!linkStatus?.block && linkStatus.block.typeId === TRANSPOSER_ID;
  if (destValid) {
    setTransposerState(linkStatus.block, desiredState);
  }

  for (const { entity, kind } of candidates) {
    if (!entity || !stateKey) continue;
    const isItem = kind === "item";
    if (kind === "player" && entity.hasTag?.(TRANSPOSER_EXIT_TAG) && isEntityOnTransposer(entity)) {
      recordFailure(stateKey, "COOLDOWN");
      notifyPlayer(entity, "COOLDOWN", nowTick);
      continue;
    }
    if (entity.hasTag?.(TRANSPOSER_COOLDOWN_TAG)) {
      recordFailure(stateKey, "COOLDOWN");
      notifyPlayer(entity, "COOLDOWN", nowTick);
      if (!isItem && shouldPlayFailFx(key, "COOLDOWN", nowTick, 20)) {
        applyFailFx(dim, center, SFX_FAIL);
      }
      continue;
    }

    if (!linkedKey) {
      recordFailure(stateKey, "NO_LINK");
      notifyPlayer(entity, "NO_LINK", nowTick);
      if (!isItem && shouldPlayFailFx(key, "NO_LINK", nowTick, 20)) {
        applyFailFx(dim, center, SFX_FAIL);
      }
      continue;
    }

    if (!destValid || !linkStatus?.dim || !linkStatus?.parsed) {
      recordFailure(stateKey, "DEST_INVALID");
      notifyPlayer(entity, "DEST_INVALID", nowTick);
      if (!isItem && shouldPlayFailFx(key, "DEST_INVALID", nowTick, 20)) {
        applyFailFx(dim, center, SFX_FAIL);
      }
      continue;
    }

    const needsCharge = kind !== "item";
    if (needsCharge && charge < 1) {
      recordFailure(stateKey, "NO_CHARGE");
      notifyPlayer(entity, "NO_CHARGE", nowTick);
      if (!isItem && shouldPlayFailFx(key, "NO_CHARGE", nowTick, 60)) {
        applyFailFx(dim, center, SFX_UNPOWERED);
      }
      continue;
    }

    const destLoc = resolveTeleportLocation(linkStatus.dim, linkStatus.parsed);
    if (!destLoc) {
      recordFailure(stateKey, "DEST_INVALID");
      notifyPlayer(entity, "DEST_INVALID", nowTick);
      if (!isItem && shouldPlayFailFx(key, "DEST_INVALID", nowTick, 20)) {
        applyFailFx(dim, center, SFX_FAIL);
      }
      continue;
    }

    if (needsCharge) {
      if (!spendSharedCharge(stateKey, 1)) {
        recordFailure(stateKey, "NO_CHARGE");
        notifyPlayer(entity, "NO_CHARGE", nowTick);
        if (!isItem && shouldPlayFailFx(key, "NO_CHARGE", nowTick, 60)) {
          applyFailFx(dim, center, SFX_UNPOWERED);
        }
        continue;
      }
      charge = Math.max(0, (charge | 0) - 1);
    }

    playTeleportFxStart(dim, entity.location || center);
    try {
      entity.teleport(destLoc, { dimension: linkStatus.dim, keepVelocity: false });
    } catch {
      // ignore
    }

    system.runTimeout(() => {
      try {
        const endDim = entity.dimension;
        const endLoc = entity.location;
        if (endDim && endLoc) playTeleportFxEnd(endDim, endLoc);
      } catch {
        // ignore
      }
    }, 1);

    const cooldownTicks = kind === "item" ? COOLDOWN_TICKS_ITEM : COOLDOWN_TICKS_ENTITY;
    scheduleCooldownClear(entity, cooldownTicks);
    if (kind === "player") {
      try {
        entity.addTag?.(TRANSPOSER_EXIT_TAG);
      } catch {
        // ignore
      }
    }
    recordTeleport(stateKey, kind, nowTick, cooldownTicks);
  }
}

export function startTransposerSystem() {
  system.runTimeout(() => {
    loadTransposerPairsFromWorldSafe();
    loadRegistry();
  }, 1);

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const block = ev?.block;
      if (!block || block.typeId !== TRANSPOSER_ID) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (key) addTransposerKey(key);
    } catch {
      // ignore
    }
  });

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev?.brokenBlockPermutation?.type?.id;
      if (brokenId !== TRANSPOSER_ID) return;
      const block = ev?.block;
      if (!block) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (key) removeTransposerKey(key);
    } catch {
      // ignore
    }
  });

  world.beforeEvents.itemUseOn.subscribe((ev) => {
    try {
      const player = ev?.source;
      const block = ev?.block;
      const item = ev?.itemStack;
      if (!player || !block || !item) return;
      if (block.typeId !== TRANSPOSER_ID) return;
      if (!isFluxTypeId(item.typeId)) return;

      const tier = Math.max(1, getFluxTier(item.typeId) || 1);
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKey(dimId, loc.x, loc.y, loc.z);
      if (!key) return;
      const stateKey = getSharedStateKey(key, linkedKey);
      if (!stateKey) return;

      const inventory = player.getComponent?.("minecraft:inventory");
      const container = inventory?.container;
      if (!container) return;
      const slot = player.selectedSlotIndex | 0;
      const held = container.getItem(slot);
      if (!held || held.typeId !== item.typeId) return;
      if ((held.amount | 0) <= 0) return;

      const added = addSharedCharge(stateKey, tier);
      if (added <= 0) return;

      if ((held.amount | 0) <= 1) container.setItem(slot, undefined);
      else {
        held.amount = Math.max(0, (held.amount | 0) - 1);
        container.setItem(slot, held);
      }

      const center = { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
      safePlaySoundAt(block.dimension, "random.orb", center);
      safeSpawnParticle(block.dimension, "chaos:link_input_charge", center);

      const snapshot = getSharedStateSnapshot(stateKey);
      const charge = Math.max(0, snapshot?.charge | 0);
      const limits = getChargeLimits();
      const maxCharge = Math.max(0, limits?.max | 0);
      const desiredState = linkedKey
        ? (charge > maxCharge ? STATE_OVERCHARGED : charge > 0 ? STATE_CHARGED : STATE_LINKED_UNPOWERED)
        : STATE_UNLINKED;
      setTransposerState(block, desiredState);
      if (linkedKey) {
        const parsed = parseKey(linkedKey);
        const dim = parsed ? world.getDimension(parsed.dimId) : null;
        const linkedBlock = dim?.getBlock?.({ x: parsed.x, y: parsed.y, z: parsed.z });
        if (linkedBlock?.typeId === TRANSPOSER_ID) {
          setTransposerState(linkedBlock, desiredState);
        }
      }
    } catch {
      // ignore
    }
  });

  system.runInterval(() => {
    const nowTick = system.currentTick | 0;
    saveTransposerPairsIfDirty();
    saveRegistry();

    for (const player of world.getAllPlayers()) {
      try {
        const dim = player.dimension;
        const loc = player.location;
        if (!dim || !loc) continue;
        const blockLoc = {
          x: Math.floor(loc.x),
          y: Math.floor(loc.y) - 1,
          z: Math.floor(loc.z),
        };
        const block = dim.getBlock(blockLoc);
        if (!block || block.typeId !== TRANSPOSER_ID) continue;
        const key = makeKey(dim.id, blockLoc.x, blockLoc.y, blockLoc.z);
        if (key) addTransposerKey(key);
      } catch {
        // ignore
      }
    }

    for (const player of world.getAllPlayers()) {
      try {
        if (!player?.hasTag?.(TRANSPOSER_EXIT_TAG)) continue;
        if (!isEntityOnTransposer(player)) {
          player.removeTag?.(TRANSPOSER_EXIT_TAG);
        }
      } catch {
        // ignore
      }
    }

    if (transposerKeys.size === 0) return;
    const keys = Array.from(transposerKeys.values());
    const budget = Math.min(MAX_TRANSPOSERS_PER_TICK, keys.length);
    let index = nowTick % keys.length;

    for (let i = 0; i < budget; i++) {
      const key = keys[index % keys.length];
      index++;
      if (key) processTransposer(key, nowTick);
    }
  }, TICK_INTERVAL);
}
