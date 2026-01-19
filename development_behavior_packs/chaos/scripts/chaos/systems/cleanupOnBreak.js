// scripts/chaos/cleanupOnBreak.js
import { world, system } from "@minecraft/server";
import { PRISM_IDS } from "../features/logistics/config.js";
import {
  canonicalizePrismKey,
  key as makePrismKey,
  parseKey as parsePrismKey,
} from "../features/logistics/keys.js";

const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:logistics_prism_levels_v1";

const LEVEL_STEP = 100;
const MAX_LEVEL = 5;
const DROP_MATCH_TICKS = 20;
const DROP_SCAN_RADIUS = 4.0;
const DROP_SCAN_MAX_PER_TICK = 8;
const INV_MATCH_TICKS = 60;
const INV_SCAN_MAX_PER_TICK = 4;

const pendingTierDrops = [];
const pendingInventoryTags = [];

function makeKeyFromParts(dimId, loc) {
  return makePrismKey(dimId, loc.x, loc.y, loc.z);
}

function parseKey(key) {
  const parsed = parsePrismKey(key);
  if (!parsed) return null;
  return {
    dimId: parsed.dimId,
    pos: { x: parsed.x, y: parsed.y, z: parsed.z },
  };
}

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeLevelMap(obj) {
  if (!obj || typeof obj !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    const canonical = canonicalizePrismKey(key);
    if (!canonical) continue;
    normalized[canonical] = value;
  }
  return normalized;
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function loadLevelMap(dpKey) {
  try {
    const raw = world.getDynamicProperty(dpKey);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return normalizeLevelMap(parsed);
  } catch {
    return {};
  }
}

function saveLevelMap(dpKey, map) {
  try {
    const raw = safeJsonStringify(map);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(dpKey, raw);
  } catch {
    // ignore
  }
}

function getLevelForCount(count) {
  const base = Math.max(1, LEVEL_STEP | 0);
  let needed = base;
  let total = 0;
  const c = Math.max(0, count | 0);
  for (let lvl = 1; lvl <= MAX_LEVEL; lvl++) {
    total += needed;
    if (c < total) return lvl;
    needed *= 2;
  }
  return MAX_LEVEL;
}

function getMinCountForLevel(level) {
  const base = Math.max(1, LEVEL_STEP | 0);
  const lvl = Math.max(1, level | 0);
  let needed = base;
  let total = 0;
  for (let i = 1; i < lvl; i++) {
    total += needed;
    needed *= 2;
  }
  return total;
}

function getNextTierDelta(count) {
  const lvl = getLevelForCount(count);
  if (lvl >= MAX_LEVEL) return 0;
  const nextMin = getMinCountForLevel(lvl + 1);
  return Math.max(0, nextMin - Math.max(0, count | 0));
}

function getLevelFromPermutation(perm) {
  try {
    const lvl = perm?.getState?.("chaos:level");
    if (Number.isFinite(lvl)) return lvl | 0;
  } catch {
    // ignore
  }
  return 1;
}

function getDropDpKey(typeId) {
  // Unified system - all prisms use DP_PRISM_LEVELS
  if (typeId && PRISM_IDS.includes(typeId)) return DP_PRISM_LEVELS;
  return null;
}

function getCountForBreak(typeId, key, perm) {
  const dpKey = getDropDpKey(typeId);
  if (!dpKey) return 0;
  const map = loadLevelMap(dpKey);
  const raw = map[key];
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n | 0;
  const level = getLevelFromPermutation(perm);
  return getMinCountForLevel(level);
}

function clearCountForKey(typeId, key) {
  const dpKey = getDropDpKey(typeId);
  if (!dpKey) return;
  const map = loadLevelMap(dpKey);
  if (map && Object.prototype.hasOwnProperty.call(map, key)) {
    delete map[key];
    saveLevelMap(dpKey, map);
  }
}

function writeCountForKey(typeId, key, count) {
  const dpKey = getDropDpKey(typeId);
  if (!dpKey) return;
  const map = loadLevelMap(dpKey);
  map[key] = Math.max(0, count | 0);
  saveLevelMap(dpKey, map);
}

function readCountFromItem(item) {
  try {
    if (!item) return 0;
    if (typeof item.getDynamicProperty === "function") {
      const dp = item.getDynamicProperty("chaos:transfer_count");
      if (Number.isFinite(dp)) return dp | 0;
    }
    if (typeof item.getLore === "function") {
      const lore = item.getLore();
      if (Array.isArray(lore)) {
        for (const line of lore) {
          if (typeof line !== "string") continue;
          const m = line.match(/Transfers:\s*(\d+)/i);
          if (m) return Number(m[1]) | 0;
          const t = line.match(/Tier:\s*(\d+)/i);
          if (t) return getMinCountForLevel(Number(t[1]) | 0);
        }
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

function applyItemTierLore(item, count) {
  try {
    if (!item || typeof item.setLore !== "function") return;
    const delta = getNextTierDelta(count);
    const level = getLevelForCount(count);
    const nextLine = delta > 0 ? `Next tier in: ${delta}` : "Max tier";
    item.setLore([`Chaos Tier: ${level}`, `Transfers: ${count | 0}`, nextLine]);
  } catch {
    // ignore
  }
}

function applyItemTierProps(item, count) {
  try {
    if (!item) return;
    if (typeof item.setDynamicProperty === "function") {
      item.setDynamicProperty("chaos:transfer_count", Math.max(0, count | 0));
    }
    applyItemTierLore(item, count);
  } catch {
    // ignore
  }
}

function isTargetDropEntity(entity) {
  try {
    return entity?.typeId === "minecraft:item";
  } catch {
    return false;
  }
}

function getItemStackFromEntity(entity) {
  try {
    const comp = entity.getComponent("minecraft:item");
    const stack = comp?.itemStack;
    if (!stack) return null;
    return { comp, stack };
  } catch {
    return null;
  }
}

function addPendingDrop(dimId, loc, typeId, count) {
  pendingTierDrops.push({
    dimId,
    loc: { x: loc.x, y: loc.y, z: loc.z },
    typeId,
    count: Math.max(0, count | 0),
    tick: system.currentTick || 0,
  });
}

function addPendingInventoryTag(playerId, typeId, count) {
  if (!playerId || !typeId || count <= 0) return;
  pendingInventoryTags.push({
    playerId,
    typeId,
    count: Math.max(0, count | 0),
    tick: system.currentTick || 0,
  });
}

function getPlayerById(playerId) {
  if (!playerId) return null;
  for (const player of world.getAllPlayers()) {
    if (player?.id === playerId) return player;
  }
  return null;
}

function tryApplyTierToInventory(player, typeId, count) {
  try {
    const inv = player?.getComponent("minecraft:inventory");
    const container = inv?.container;
    if (!container) return false;
    const size = container.size;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      if (readCountFromItem(it) > 0) continue;
      applyItemTierProps(it, count);
      try { container.setItem(i, it); } catch { return false; }
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function matchPendingDrop(entityLoc, dimId, typeId) {
  const now = system.currentTick || 0;
  for (let i = pendingTierDrops.length - 1; i >= 0; i--) {
    const p = pendingTierDrops[i];
    if (!p) {
      pendingTierDrops.splice(i, 1);
      continue;
    }
    if ((now - p.tick) > DROP_MATCH_TICKS) {
      pendingTierDrops.splice(i, 1);
      continue;
    }
    if (p.dimId !== dimId || p.typeId !== typeId) continue;
    const dx = entityLoc.x - p.loc.x;
    const dy = entityLoc.y - p.loc.y;
    const dz = entityLoc.z - p.loc.z;
    if ((dx * dx + dy * dy + dz * dz) <= 2.25) {
      pendingTierDrops.splice(i, 1);
      return p;
    }
  }
  return null;
}

function scanPendingDrops() {
  const now = system.currentTick || 0;
  let budget = DROP_SCAN_MAX_PER_TICK;
  if (budget <= 0 || pendingTierDrops.length === 0) return;

  for (let i = pendingTierDrops.length - 1; i >= 0 && budget > 0; i--) {
    const p = pendingTierDrops[i];
    if (!p) {
      pendingTierDrops.splice(i, 1);
      continue;
    }
    if ((now - p.tick) > DROP_MATCH_TICKS) {
      pendingTierDrops.splice(i, 1);
      continue;
    }

    const dim = world.getDimension(p.dimId);
    if (!dim) continue;
    let entities = [];
    try {
      entities = dim.getEntities({
        type: "minecraft:item",
        location: p.loc,
        maxDistance: DROP_SCAN_RADIUS,
      });
    } catch {
      entities = [];
    }
    if (!entities || entities.length === 0) continue;

    for (const entity of entities) {
      const itemInfo = getItemStackFromEntity(entity);
      if (!itemInfo || !itemInfo.stack) continue;
      if (itemInfo.stack.typeId !== p.typeId) continue;
      applyItemTierProps(itemInfo.stack, p.count);
      if (itemInfo.comp) itemInfo.comp.itemStack = itemInfo.stack;
      pendingTierDrops.splice(i, 1);
      budget--;
      break;
    }
  }
}

function scanPendingInventoryTags() {
  const now = system.currentTick || 0;
  let budget = INV_SCAN_MAX_PER_TICK;
  if (budget <= 0 || pendingInventoryTags.length === 0) return;

  for (let i = pendingInventoryTags.length - 1; i >= 0 && budget > 0; i--) {
    const p = pendingInventoryTags[i];
    if (!p) {
      pendingInventoryTags.splice(i, 1);
      continue;
    }
    if ((now - p.tick) > INV_MATCH_TICKS) {
      pendingInventoryTags.splice(i, 1);
      continue;
    }

    const player = getPlayerById(p.playerId);
    if (!player) {
      pendingInventoryTags.splice(i, 1);
      continue;
    }
    if (tryApplyTierToInventory(player, p.typeId, p.count)) {
      pendingInventoryTags.splice(i, 1);
      budget--;
    }
  }
}
function handleBrokenNode(player, dimId, loc) {
  // Pairs cleanup removed - beam simulation handles connection cleanup automatically
  // This function is kept for potential future use but currently does nothing
  // Level counts cleanup is handled separately below
}

export function startCleanupOnBreak() {
  // ✅ Reliable source of "what block was broken" is brokenBlockPermutation
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const player = ev.player;
      const block = ev.block; // location + dimension are still useful

      if (!block) return;

      const brokenId = ev.brokenBlockPermutation?.type?.id;
      if (!brokenId || !PRISM_IDS.includes(brokenId)) return;

      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;

      handleBrokenNode(player, dimId, loc);
      const key = makeKeyFromParts(dimId, loc);
      const count = getCountForBreak(brokenId, key, ev.brokenBlockPermutation);
      clearCountForKey(brokenId, key);
      addPendingDrop(dimId, loc, brokenId, count);
      if (player?.id) addPendingInventoryTag(player.id, brokenId, count);
    } catch {
      // ignore
    }
  });

  try {
    world.afterEvents.entitySpawn?.subscribe((ev) => {
      try {
        const entity = ev?.entity;
        if (!isTargetDropEntity(entity)) return;
        const loc = entity.location;
        const dimId = entity.dimension?.id;
        if (!loc || !dimId) return;

        const itemInfo = getItemStackFromEntity(entity);
        if (!itemInfo || !itemInfo.stack) return;

        const typeId = itemInfo.stack.typeId;
        if (!typeId || !PRISM_IDS.includes(typeId)) return;

        const pending = matchPendingDrop(loc, dimId, typeId);
        if (!pending) return;

        applyItemTierProps(itemInfo.stack, pending.count);
        if (itemInfo.comp) itemInfo.comp.itemStack = itemInfo.stack;
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  system.runInterval(() => {
    try {
      scanPendingDrops();
      scanPendingInventoryTags();
    } catch {
      // ignore
    }
  }, 1);

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const block = ev?.block;
      if (!block) return;
      const typeId = block.typeId;
      if (!typeId || !PRISM_IDS.includes(typeId)) return;

      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const key = makeKeyFromParts(dimId, loc);

      const item = ev?.itemStack;
      const count = readCountFromItem(item);
      const level = getLevelForCount(count);

      try {
        const perm = block.permutation;
        if (perm) block.setPermutation(perm.withState("chaos:level", level | 0));
      } catch {
        // ignore
      }

      if (count > 0) writeCountForKey(typeId, key, count);
      else clearCountForKey(typeId, key);
    } catch {
      // ignore
    }
  });

  // Optional explosions etc. left out here on purpose:
  // those events vary by version and aren’t critical for your milestone.
}



