// scripts/chaos/crystallizer.js
import { world, system, ItemStack } from "@minecraft/server";
import { makeKeyFromBlock } from "./features/links/network/keys.js";
import { FLUX_IDS } from "./flux.js";

const CRYSTALLIZER_ID = "chaos:crystallizer";
const CRYSTAL_ENTITY_ID = "minecraft:armor_stand";
const CRYSTAL_TAG = "chaos_crystal";
const CRYS_KEY_TAG_PREFIX = "crysKey:";

const DP_CRYSTALLIZER_LIST = "chaos:crystallizers_v0_json";
const DP_CRYSTAL_STATE_PREFIX = "chaos:crystal_state|";

const TICK_INTERVAL = 10;
const BUDGET_PER_TICK = 4;
const RESPAWN_DELAY_TICKS = 40;

// Safely initialize FLUX_VALUE_BY_ID - handle case where FLUX_IDS might not be available
const FLUX_VALUE_BY_ID = (() => {
  try {
    if (typeof FLUX_IDS !== 'undefined' && Array.isArray(FLUX_IDS) && FLUX_IDS.length >= 5) {
      return new Map([
        [FLUX_IDS[0], 1],
        [FLUX_IDS[1], 3],
        [FLUX_IDS[2], 7],
        [FLUX_IDS[3], 15],
        [FLUX_IDS[4], 30],
      ]);
    }
  } catch {
    // ignore
  }
  return new Map();
})();

const crystalKeys = new Set();
let crystalList = [];
let cursor = 0;
const suppressDropIds = new Set();

function makeKeyTag(key) {
  return `${CRYS_KEY_TAG_PREFIX}${key}`;
}

function parseKey(key) {
  try {
    if (typeof key !== "string") return null;
    const p = key.indexOf("|");
    if (p <= 0) return null;
    const dimId = key.slice(0, p);
    const rest = key.slice(p + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { dimId, x: x | 0, y: y | 0, z: z | 0 };
  } catch {
    return null;
  }
}

function safeJsonParse(raw, fallback) {
  try {
    if (typeof raw !== "string" || !raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

function loadRegistry() {
  const raw = world.getDynamicProperty(DP_CRYSTALLIZER_LIST);
  const list = safeJsonParse(raw, []);
  crystalKeys.clear();
  for (const k of list) {
    if (typeof k === "string" && k.length) crystalKeys.add(k);
  }
  crystalList = Array.from(crystalKeys);
}

function saveRegistry() {
  const raw = safeJsonStringify(Array.from(crystalKeys));
  if (typeof raw !== "string") return;
  world.setDynamicProperty(DP_CRYSTALLIZER_LIST, raw);
}

function refreshList() {
  crystalList = Array.from(crystalKeys);
  if (cursor >= crystalList.length) cursor = 0;
}

export function getCrystalState(key) {
  try {
    const raw = world.getDynamicProperty(`${DP_CRYSTAL_STATE_PREFIX}${key}`);
    const parsed = safeJsonParse(raw, null);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return { fluxStored: 0, fluxTotalLifetime: 0, prestigeCount: 0, level: 1 };
}

export function setCrystalState(key, state) {
  try {
    const next = Object.assign(
      { fluxStored: 0, fluxTotalLifetime: 0, prestigeCount: 0, level: 1 },
      state || {}
    );
    const raw = safeJsonStringify(next);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(`${DP_CRYSTAL_STATE_PREFIX}${key}`, raw);
  } catch {
    // ignore
  }
}

function ensureCrystalState(key) {
  const current = getCrystalState(key);
  if (!current || typeof current !== "object") {
    setCrystalState(key, { fluxStored: 0, prestigeCount: 0 });
  }
}

function getCrystalEntities(dim, key) {
  try {
    if (!dim) return [];
    return dim.getEntities({ tags: [CRYSTAL_TAG, makeKeyTag(key)] }) ?? [];
  } catch {
    return [];
  }
}

function getCrystalTargetPos(loc) {
  return { x: loc.x + 0.5, y: loc.y + 1.2, z: loc.z + 0.5 };
}

function spawnCrystalForKey(block, key) {
  try {
    const dim = block?.dimension;
    if (!dim) return;
    const loc = block.location;
    const existing = getCrystalEntities(dim, key);
    if (existing.length > 0) return;

    const pos = getCrystalTargetPos(loc);
    const ent = dim.spawnEntity(CRYSTAL_ENTITY_ID, pos);
    if (!ent) return;
    try { ent.addTag(CRYSTAL_TAG); } catch {}
    try { ent.addTag(makeKeyTag(key)); } catch {}
  } catch {
    // ignore
  }
}

function despawnCrystalForKey(dim, key) {
  const existing = getCrystalEntities(dim, key);
  for (const ent of existing) {
    try {
      suppressDropIds.add(ent.id);
      ent.remove();
    } catch {
      // ignore
    }
  }
}

function resolveBlockForKey(key) {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const dim = world.getDimension(parsed.dimId);
  if (!dim) return null;
  const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  if (!block) return null;
  return block;
}

export function getFluxValueForItem(typeId) {
  return FLUX_VALUE_BY_ID.get(typeId) || 0;
}

export function addFluxForItem(key, typeId, amount) {
  try {
    const value = getFluxValueForItem(typeId);
    if (value <= 0) return 0;
    const add = value * Math.max(1, amount | 0);
    const state = getCrystalState(key);
    state.fluxStored = Math.max(0, (state.fluxStored | 0) + add);
    state.fluxTotalLifetime = Math.max(0, (state.fluxTotalLifetime | 0) + add);
    setCrystalState(key, state);
    return add;
  } catch {
    return 0;
  }
}

function registerCrystallizer(block) {
  try {
    const key = makeKeyFromBlock(block);
    if (!key || crystalKeys.has(key)) return;
    crystalKeys.add(key);
    refreshList();
    saveRegistry();
    ensureCrystalState(key);
    spawnCrystalForKey(block, key);
  } catch {
    // ignore
  }
}

function unregisterCrystallizer(key) {
  if (!key || !crystalKeys.has(key)) return;
  crystalKeys.delete(key);
  refreshList();
  saveRegistry();
  try {
    world.setDynamicProperty(`${DP_CRYSTAL_STATE_PREFIX}${key}`, "");
  } catch {
    // ignore
  }
}

function scheduleRegisterAt(dim, loc, attempt) {
  try {
    if (!dim || !loc) return;
    const a = attempt | 0;
    const block = dim.getBlock(loc);
    if (block?.typeId === CRYSTALLIZER_ID) {
      registerCrystallizer(block);
      return;
    }
    if (a < 3) system.runTimeout(() => scheduleRegisterAt(dim, loc, a + 1), 1);
  } catch {
    // ignore
  }
}

function scheduleRespawn(key) {
  system.runTimeout(() => {
    try {
      if (!crystalKeys.has(key)) return;
      const block = resolveBlockForKey(key);
      if (!block || block.typeId !== CRYSTALLIZER_ID) return;
      spawnCrystalForKey(block, key);
    } catch {
      // ignore
    }
  }, RESPAWN_DELAY_TICKS);
}

function handleEntityDie(ev) {
  try {
    const ent = ev?.deadEntity;
    if (!ent || !ent.hasTag?.(CRYSTAL_TAG)) return;
    if (suppressDropIds.has(ent.id)) {
      suppressDropIds.delete(ent.id);
      return;
    }

    let key = null;
    try {
      const tags = ent.getTags();
      if (Array.isArray(tags)) {
        for (const t of tags) {
          if (typeof t === "string" && t.startsWith(CRYS_KEY_TAG_PREFIX)) {
            key = t.slice(CRYS_KEY_TAG_PREFIX.length);
            break;
          }
        }
      }
    } catch {
      // ignore
    }

    const amount = 1 + ((Math.random() * 3) | 0);
    try {
      const stack = new ItemStack("chaos:chaos_crystal_shard", amount);
      ent.dimension.spawnItem(stack, ent.location);
    } catch {
      // ignore
    }

    if (key) scheduleRespawn(key);
  } catch {
    // ignore
  }
}

function tickCrystallizers() {
  if (crystalList.length === 0) return;
  const count = crystalList.length;
  let budget = Math.max(1, BUDGET_PER_TICK | 0);
  while (budget-- > 0 && count > 0) {
    if (cursor >= crystalList.length) cursor = 0;
    const key = crystalList[cursor++];
    if (!key) continue;
    const block = resolveBlockForKey(key);
    if (!block || block.typeId !== CRYSTALLIZER_ID) {
      unregisterCrystallizer(key);
      continue;
    }
    ensureCrystalState(key);
    spawnCrystalForKey(block, key);
  }
}

export function startCrystallizerSystem() {
  loadRegistry();

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const b = ev?.block;
      if (!b) return;
      scheduleRegisterAt(b.dimension, b.location, 0);
    } catch {
      // ignore
    }
  });

  try {
    world.afterEvents.entityPlaceBlock.subscribe((ev) => {
      try {
        const b = ev?.block;
        if (!b) return;
        scheduleRegisterAt(b.dimension, b.location, 0);
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
        const b = ev?.block;
        if (!b) return;
        scheduleRegisterAt(b.dimension, b.location, 0);
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
      if (brokenId !== CRYSTALLIZER_ID) return;
      const block = ev?.block;
      if (!block) return;
      const key = makeKeyFromBlock(block);
      const dim = block.dimension;
      despawnCrystalForKey(dim, key);
      unregisterCrystallizer(key);
    } catch {
      // ignore
    }
  });

  world.afterEvents.entityDie.subscribe(handleEntityDie);

  system.runInterval(tickCrystallizers, TICK_INTERVAL);
}

export { CRYSTAL_TAG, CRYS_KEY_TAG_PREFIX, parseKey, resolveBlockForKey };
