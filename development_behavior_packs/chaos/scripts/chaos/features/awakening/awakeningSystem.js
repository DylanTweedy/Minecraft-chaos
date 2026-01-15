// scripts/chaos/features/awakening/awakeningSystem.js
//
// Awakening System (MVP)
// - Diablo-like affixes + 5 awakening tiers
// - Prestige Points (PP) influence tier upgrade chance on reroll
// - Preserves item history in a world DB (dynamic property if available; RAM fallback otherwise)
// - Obfuscated reveal (scrambled name) during reroll for suspense
//
// Commands:
//   !awk            -> help
//   !awk info       -> show held item awakening info
//   !awk reroll     -> reroll held eligible item (requires 1 chaos:prestige_shard unless FREE_MODE)
//   !awk grantpp N  -> dev: add PP to held item's soul
//   !awk setlvl N   -> dev: set held item's "level" (used only for PP math later; stored now)
//
// Configure eligible items + affix pools near the top.
//
// NOTE: No effects are applied in this script. This is stats/affixes + persistence only.

import {
  world,
  system,
  ItemStack,
  EntityComponentTypes,
} from "@minecraft/server";

// -------------------------
// Config
// -------------------------

const FREE_MODE = false; // true = doesn't require prestige shard
const PRESTIGE_SHARD_ID = "chaos:prestige_shard";

const INTERVAL_SCAN_TICKS = 20;      // for chat hook + autosave cadence
const REVEAL_DELAY_TICKS = 20;       // "scrambled" reveal duration (~1 second)
const MAX_HISTORY_LINES = 20;        // stored per soul record
const MAX_LORE_HISTORY_LINES = 3;    // show last N history entries on item lore

const AWAKEN_TIERS = 5;

// World DB dynamic property key
const DP_WORLD_DB = "chaos:awakening_db_v1";

// Safety: if world DP registration fails in your API build, we fall back to RAM.
let WorldDbAvailable = false;

// -------------------------
// Affix Pools
// -------------------------
//
// You can add more items and pools over time.
// Each affix has:
// - key: internal name
// - label: shown to player
// - min/max: rolled value range (Tier influences the roll weight/range later; MVP uses min/max as-is)
// - statKey: what this affix is conceptually tied to (steps/mined/etc.) (for later integration)
// - effectHint: just metadata for later (no effects applied now)

const POOLS = {
  "chaos:godsteel_chestplate": {
    displayName: "Godsteel Chestplate",
    affixes: [
      { key: "resist", label: "Resistance", min: 1, max: 3, statKey: "damage_taken", effectHint: "minecraft:resistance" },
      { key: "strength", label: "Strength", min: 1, max: 2, statKey: "hits_dealt", effectHint: "minecraft:strength" },
      { key: "absorb", label: "Absorption", min: 1, max: 4, statKey: "time_worn", effectHint: "minecraft:absorption" },
      { key: "hp", label: "Health Boost", min: 1, max: 4, statKey: "time_worn", effectHint: "minecraft:health_boost" },
      { key: "fireres", label: "Fire Resistance", min: 1, max: 1, statKey: "lava_time", effectHint: "minecraft:fire_resistance" },
      { key: "regen", label: "Regeneration", min: 1, max: 2, statKey: "damage_taken", effectHint: "minecraft:regeneration" },
    ],
  },

  // Examples for later:
  // "chaos:godsteel_boots": { displayName:"Godsteel Boots", affixes:[ ... steps -> speed ... ] },
  // "chaos:godsteel_pickaxe": { displayName:"Godsteel Pickaxe", affixes:[ ... mined -> haste ... ] },
};

// -------------------------
// Internal DB + helpers
// -------------------------

/**
 * DB format:
 * {
 *   souls: {
 *     "<soulId>": {
 *       soulId,
 *       ownerHint,        // last known player name (not authoritative)
 *       itemTypeId,
 *       awakenedTier,     // 1..5
 *       prestige,         // integer
 *       level,            // integer (placeholder for now)
 *       pp,               // prestige points
 *       affixes: [ { key, label, value, statKey, effectHint } ],
 *       history: [ "..." ] // newest last
 *     }
 *   }
 * }
 */
const InMemoryDb = { souls: {} };

function nowTick() {
  try { return world.getAbsoluteTime(); } catch { return 0; }
}

function msg(player, text) {
  try { player.sendMessage(text); } catch {}
}

function worldMsg(text) {
  try { world.sendMessage(text); } catch {}
}

function safeGet(obj, key, fallback) {
  const v = obj?.[key];
  return (v === undefined || v === null) ? fallback : v;
}

function clamp(n, a, b) {
  if (n < a) return a;
  if (n > b) return b;
  return n;
}

function randInt(min, max) {
  // inclusive
  const r = Math.floor(Math.random() * (max - min + 1)) + min;
  return r;
}

function pickUnique(arr, count) {
  const copy = arr.slice();
  const out = [];
  while (copy.length > 0 && out.length < count) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy[i]);
    copy.splice(i, 1);
  }
  return out;
}

function makeSoulId() {
  // short-ish id for lore display
  const a = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const b = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const c = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `${a}-${b}-${c}`;
}

// -------------------------
// World DB persistence (best-effort)
// -------------------------

let Dirty = false;

function tryLoadWorldDb() {
  if (!WorldDbAvailable) return;

  try {
    const raw = world.getDynamicProperty(DP_WORLD_DB);
    if (typeof raw !== "string" || !raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.souls) {
      InMemoryDb.souls = parsed.souls;
    }
  } catch {
    // ignore; fallback stays
  }
}

function trySaveWorldDb() {
  if (!WorldDbAvailable || !Dirty) return;

  try {
    const raw = JSON.stringify({ souls: InMemoryDb.souls });
    world.setDynamicProperty(DP_WORLD_DB, raw);
    Dirty = false;
  } catch {
    // If saving fails, keep Dirty true and keep going (RAM still works)
  }
}

function markDirty() {
  Dirty = true;
}

// Attempt to register world dynamic property in a few common API shapes.
// If all fail, we keep RAM-only mode.
world.afterEvents.worldInitialize.subscribe((e) => {
  try {
    // Some builds support an object-based registry.
    e.propertyRegistry.registerWorldDynamicProperties({
      [DP_WORLD_DB]: { type: "string", maxLength: 200000 },
    });
    WorldDbAvailable = true;
  } catch {
    try {
      // Some builds expose defineString style; try that.
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_WORLD_DB, 200000)
      );
      WorldDbAvailable = true;
    } catch {
      WorldDbAvailable = false;
    }
  }

  if (WorldDbAvailable) {
    tryLoadWorldDb();
    worldMsg("§a[Awakening] World DB enabled.");
  } else {
    worldMsg("§e[Awakening] World DB unavailable in this API build. Using RAM-only (history won't survive restart).");
  }
});

// Autosave cadence (best-effort)
system.runInterval(() => {
  trySaveWorldDb();
}, 100);

// -------------------------
// Item access helpers
// -------------------------

function getInventory(player) {
  try {
    return player.getComponent(EntityComponentTypes.Inventory);
  } catch {
    return undefined;
  }
}

function getContainer(player) {
  const inv = getInventory(player);
  if (!inv) return undefined;
  try {
    return inv.container;
  } catch {
    return undefined;
  }
}

function getSelectedSlotIndex(player) {
  try {
    // property exists on most builds
    return player.selectedSlotIndex | 0;
  } catch {
    return 0;
  }
}

function getHeldItem(player) {
  const c = getContainer(player);
  if (!c) return undefined;
  const slot = getSelectedSlotIndex(player);
  try {
    return c.getItem(slot);
  } catch {
    return undefined;
  }
}

function setHeldItem(player, item) {
  const c = getContainer(player);
  if (!c) return false;
  const slot = getSelectedSlotIndex(player);
  try {
    c.setItem(slot, item);
    return true;
  } catch {
    return false;
  }
}

function tryGetLore(item) {
  try { return item.getLore() ?? []; } catch { return []; }
}

function trySetLore(item, loreLines) {
  try { item.setLore(loreLines); return true; } catch { return false; }
}

function hasItem(player, typeId, countNeeded) {
  const c = getContainer(player);
  if (!c) return false;

  let found = 0;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (it && it.typeId === typeId) {
      found += (it.amount | 0) || 1;
      if (found >= countNeeded) return true;
    }
  }
  return false;
}

function consumeItem(player, typeId, countNeeded) {
  const c = getContainer(player);
  if (!c) return false;

  let remaining = countNeeded;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (!it || it.typeId !== typeId) continue;

    const amt = (it.amount | 0) || 1;
    const take = Math.min(amt, remaining);
    remaining -= take;

    if (amt - take <= 0) c.setItem(i, undefined);
    else {
      it.amount = amt - take;
      c.setItem(i, it);
    }

    if (remaining <= 0) return true;
  }

  return false;
}

// -------------------------
// Soul binding + lore
// -------------------------

function findSoulIdInLore(lore) {
  // looks for: "§8Soul: XXXX-XXXX-XXXX"
  for (const line of lore) {
    const idx = line.indexOf("Soul:");
    if (idx === -1) continue;
    const tail = line.slice(idx + 5).trim();
    if (tail.length >= 4) return tail;
  }
  return null;
}

function ensureSoul(item, playerNameHint) {
  const lore = tryGetLore(item);
  let soulId = findSoulIdInLore(lore);

  if (!soulId) {
    soulId = makeSoulId();
    lore.push(`§8Soul: ${soulId}`);
    trySetLore(item, lore);
  }

  // Ensure DB record exists
  let rec = InMemoryDb.souls[soulId];
  if (!rec) {
    rec = {
      soulId,
      ownerHint: playerNameHint || "",
      itemTypeId: item.typeId,
      awakenedTier: 1,
      prestige: 0,
      level: 0,
      pp: 0,
      affixes: [],
      history: [],
    };
    InMemoryDb.souls[soulId] = rec;
    markDirty();
  } else {
    // keep itemTypeId updated
    rec.itemTypeId = item.typeId;
    rec.ownerHint = playerNameHint || rec.ownerHint;
  }

  return { soulId, rec };
}

function pushHistory(rec, line) {
  const t = nowTick();
  const entry = `t${t}: ${line}`;
  rec.history = rec.history || [];
  rec.history.push(entry);
  while (rec.history.length > MAX_HISTORY_LINES) rec.history.shift();
}

function formatAffixLine(a) {
  // Example: "§b+2§r Resistance §8(damage_taken)"
  return `§b+${a.value}§r ${a.label} §8(${a.statKey})`;
}

function updateItemDisplay(item, rec) {
  const pool = POOLS[item.typeId];
  const baseName = pool?.displayName ?? item.typeId;

  // NameTag: include tier + prestige
  // (No §k here; this is the revealed form)
  item.nameTag = `§f${baseName} §7[§dAwk T${rec.awakenedTier}§7] §6P${rec.prestige}`;

  const lore = [];
  lore.push(`§7Level: §f${rec.level} §8| §7PP: §f${rec.pp}`);
  lore.push(`§7Tier: §f${rec.awakenedTier}§8/§f${AWAKEN_TIERS} §8| §7Prestige: §f${rec.prestige}`);

  // Affixes
  if (rec.affixes?.length) {
    lore.push(`§7Affixes:`);
    for (const a of rec.affixes) lore.push(formatAffixLine(a));
  } else {
    lore.push(`§7Affixes: §8(none)`);
  }

  // Show last few history lines
  const hist = rec.history || [];
  if (hist.length) {
    lore.push(`§7History:`);
    const start = Math.max(0, hist.length - MAX_LORE_HISTORY_LINES);
    for (let i = start; i < hist.length; i++) {
      lore.push(`§8- ${hist[i]}`);
    }
  }

  // Soul line MUST exist for binding
  lore.push(`§8Soul: ${rec.soulId}`);

  trySetLore(item, lore);
}

// -------------------------
// Reroll logic
// -------------------------

function tierUpgradeChance(fromTier, ppSpent) {
  // Tunable base chances. These feel “rare but possible.”
  // You can change these later without breaking saves.
  const base = {
    1: 0.06, // 1->2
    2: 0.025, // 2->3
    3: 0.010, // 3->4
    4: 0.004, // 4->5
  }[fromTier] ?? 0;

  // PP boosts chance with diminishing returns
  // p = base + (1-base)*(1-exp(-pp/k))
  const k = 40; // bigger = slower ramp
  const boost = 1 - Math.exp(-ppSpent / k);
  const p = base + (1 - base) * boost;
  return clamp(p, 0, 0.95);
}

function rollAffixes(itemTypeId, tier) {
  const pool = POOLS[itemTypeId];
  if (!pool) return [];

  const count = clamp(tier, 1, AWAKEN_TIERS);
  const picks = pickUnique(pool.affixes, Math.min(count, pool.affixes.length));

  const out = [];
  for (const a of picks) {
    const value = randInt(a.min, a.max);
    out.push({
      key: a.key,
      label: a.label,
      value,
      statKey: a.statKey,
      effectHint: a.effectHint,
    });
  }
  return out;
}

function scrambleName(item, baseLabel) {
  // Obfuscated gibberish. §k makes it appear random.
  // Marker included so we can recognize "pending reveal" state if needed later.
  item.nameTag = `§kXXXXXXXXXXXX§r §f${baseLabel} §7[§dAwakening…§7] §8#PENDING`;
  const lore = tryGetLore(item).filter(l => !l.includes("Soul:"));
  lore.push("§8(awakening in progress)");
  trySetLore(item, lore);
}

function isEligible(item) {
  return !!item && !!POOLS[item.typeId];
}

function doReroll(player) {
  const held = getHeldItem(player);
  if (!held) return msg(player, "§c[Awakening] Hold an item first.");

  if (!isEligible(held)) {
    return msg(player, `§c[Awakening] That item has no affix pool yet: §f${held.typeId}`);
  }

  if (!FREE_MODE) {
    if (!hasItem(player, PRESTIGE_SHARD_ID, 1)) {
      return msg(player, `§c[Awakening] Missing ingredient: §f${PRESTIGE_SHARD_ID}`);
    }
  }

  // Bind soul + load record
  const { rec } = ensureSoul(held, player.name);

  // Spend PP to boost tier upgrade odds (MVP: spend all)
  const ppSpent = rec.pp | 0;

  // Maybe tier up
  let newTier = rec.awakenedTier | 0;
  if (newTier < AWAKEN_TIERS) {
    const chance = tierUpgradeChance(newTier, ppSpent);
    if (Math.random() < chance) {
      newTier += 1;
      pushHistory(rec, `Tier up! -> T${newTier} (ppSpent=${ppSpent})`);
    } else {
      pushHistory(rec, `Reroll (no tier up) (ppSpent=${ppSpent})`);
    }
  } else {
    pushHistory(rec, `Reroll at max tier (ppSpent=${ppSpent})`);
  }

  // Consume ingredient
  if (!FREE_MODE) consumeItem(player, PRESTIGE_SHARD_ID, 1);

  // Prestige always increments on reroll (your prestige loop)
  rec.prestige = (rec.prestige | 0) + 1;
  rec.awakenedTier = newTier;

  // Reset PP after spending (MVP). Later you might spend only a portion.
  rec.pp = 0;

  // Roll new affixes
  rec.affixes = rollAffixes(held.typeId, rec.awakenedTier);

  // Scramble name briefly for suspense
  const pool = POOLS[held.typeId];
  scrambleName(held, pool?.displayName ?? held.typeId);
  setHeldItem(player, held);

  markDirty();

  // Reveal after delay: write full lore/name
  system.runTimeout(() => {
    const held2 = getHeldItem(player);
    if (!held2) return;

    // Ensure we are still on the same soul id; otherwise just exit (player swapped items)
    const lore2 = tryGetLore(held2);
    const soulId2 = findSoulIdInLore(lore2);
    if (!soulId2 || soulId2 !== rec.soulId) return;

    updateItemDisplay(held2, rec);
    setHeldItem(player, held2);
    markDirty();

    msg(player, `§a[Awakening] Revealed: §fT${rec.awakenedTier} §6P${rec.prestige} §7(${rec.affixes.length} affixes)`);
  }, REVEAL_DELAY_TICKS);
}

// -------------------------
// Commands
// -------------------------

function showHelp(player) {
  msg(player,
    "§b[Awakening] Commands:\n" +
    "§7!awk info§r  - show held awakening info\n" +
    "§7!awk reroll§r - reroll held eligible item\n" +
    "§7!awk grantpp N§r - dev: add PP\n" +
    "§7!awk setlvl N§r - dev: set level\n"
  );
}

function showInfo(player) {
  const held = getHeldItem(player);
  if (!held) return msg(player, "§c[Awakening] Hold an item first.");

  const lore = tryGetLore(held);
  const soulId = findSoulIdInLore(lore);
  if (!soulId || !InMemoryDb.souls[soulId]) {
    msg(player, `§e[Awakening] No soul bound yet. Reroll once to bind.`);
    msg(player, `§7Held: §f${held.typeId}`);
    return;
  }

  const rec = InMemoryDb.souls[soulId];
  msg(player, `§b[Awakening] §f${held.typeId}`);
  msg(player, `§7Soul: §f${rec.soulId}`);
  msg(player, `§7Tier: §fT${rec.awakenedTier}§7 | Prestige: §6${rec.prestige}§7 | Level: §f${rec.level}§7 | PP: §f${rec.pp}`);
  if (rec.affixes?.length) {
    msg(player, `§7Affixes:`);
    for (const a of rec.affixes) msg(player, `§7- §f${a.label} §b+${a.value} §8(${a.statKey})`);
  }
}

function grantPP(player, n) {
  const held = getHeldItem(player);
  if (!held) return msg(player, "§c[Awakening] Hold an item first.");
  if (!isEligible(held)) return msg(player, "§c[Awakening] That item isn't eligible yet.");

  const { rec } = ensureSoul(held, player.name);
  rec.pp = (rec.pp | 0) + (n | 0);
  pushHistory(rec, `Dev: +${n} PP`);
  updateItemDisplay(held, rec);
  setHeldItem(player, held);
  markDirty();
  msg(player, `§a[Awakening] PP is now ${rec.pp}`);
}

function setLevel(player, n) {
  const held = getHeldItem(player);
  if (!held) return msg(player, "§c[Awakening] Hold an item first.");
  if (!isEligible(held)) return msg(player, "§c[Awakening] That item isn't eligible yet.");

  const { rec } = ensureSoul(held, player.name);
  rec.level = Math.max(0, n | 0);
  pushHistory(rec, `Dev: set level ${rec.level}`);
  updateItemDisplay(held, rec);
  setHeldItem(player, held);
  markDirty();
  msg(player, `§a[Awakening] Level is now ${rec.level}`);
}

function handleAwkCommand(player, message) {
  const parts = message.trim().split(/\s+/g);
  const sub = (parts[1] ?? "").toLowerCase();

  if (!sub) return showHelp(player);
  if (sub === "help") return showHelp(player);
  if (sub === "info") return showInfo(player);
  if (sub === "reroll") return doReroll(player);

  if (sub === "grantpp") {
    const n = parseInt(parts[2] ?? "0", 10);
    if (!Number.isFinite(n)) return msg(player, "§c[Awakening] Usage: !awk grantpp 10");
    return grantPP(player, n);
  }

  if (sub === "setlvl") {
    const n = parseInt(parts[2] ?? "0", 10);
    if (!Number.isFinite(n)) return msg(player, "§c[Awakening] Usage: !awk setlvl 50");
    return setLevel(player, n);
  }

  showHelp(player);
}

function hookChat() {
  const before = world?.beforeEvents?.chatSend;
  if (before?.subscribe) {
    before.subscribe((e) => {
      const p = e.sender;
      const m = e.message ?? "";
      if (!m.startsWith("!awk")) return;
      e.cancel = true;
      handleAwkCommand(p, m);
    });
    return true;
  }

  const after = world?.afterEvents?.chatSend;
  if (after?.subscribe) {
    after.subscribe((e) => {
      const p = e.sender;
      const m = e.message ?? "";
      if (!m.startsWith("!awk")) return;
      handleAwkCommand(p, m);
    });
    return true;
  }

  return false;
}

// -------------------------
// Init
// -------------------------

export function initAwakeningSystem() {
  const ok = hookChat();
  if (!ok) worldMsg("§c[Awakening] No chatSend hook available in this API build.");
  worldMsg("§b[Awakening] Loaded. Type §f!awk§b for commands.");

  // Small QoL: ensure held eligible item gets a soul + display if already present in DB
  system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
      const held = getHeldItem(p);
      if (!held || !isEligible(held)) continue;

      const lore = tryGetLore(held);
      const soulId = findSoulIdInLore(lore);
      if (!soulId) continue;

      const rec = InMemoryDb.souls[soulId];
      if (rec) {
        // Keep display synced occasionally
        updateItemDisplay(held, rec);
        setHeldItem(p, held);
      }
    }
  }, INTERVAL_SCAN_TICKS);
}
