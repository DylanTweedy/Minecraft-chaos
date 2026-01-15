// scripts/chaos/dev/effectsLab.js
//
// Effect Lab: toggle any vanilla status effect ON/OFF, refreshes on an interval.
// - Uses string IDs (no MinecraftEffectTypes import) for compatibility.
// - Provides chat commands to toggle effects.
// - Defaults: all safe effects ON at MAX amplifier; dangerous/instant OFF unless enabled.
//
// Commands (chat):
//   !fx                 -> show help
//   !fx list            -> list effects + on/off
//   !fx on <id|all>      -> enable effect (or all)
//   !fx off <id|all>     -> disable effect (or all)
//   !fx danger on|off    -> allow dangerous defaults + "all" toggles to include harmful
//   !fx apply            -> re-apply immediately (no waiting)
//
// Example:
//   !fx on minecraft:night_vision
//   !fx off minecraft:nausea
//   !fx on all

import { world, system } from "@minecraft/server";

// -------------------------
// Config
// -------------------------

const INTERVAL_TICKS = 20;      // re-apply every second
const DURATION_TICKS = 400;      // keep > interval to prevent gaps
const MAX_AMP = 7;           // "max level" in practice (0 = level I)
const SHOW_PARTICLES = true;

// "Danger" effects include harmful or disruptive ones.
// By default, these start OFF and are excluded from "!fx on all" unless dangerEnabled=true.
let dangerEnabled = false;

// -------------------------
// Effect Registry
// -------------------------

// Notes:
// - Instant effects (instant_health/instant_damage) are NOT reapplied on interval.
//   They fire once when turned on (and are classified as DANGER).
// - Some effects may not exist in every Bedrock version. We'll ignore errors quietly.

const EFFECTS = [
  // Movement / mining
  { id: "minecraft:speed", danger: false },
  { id: "minecraft:slowness", danger: true },
  { id: "minecraft:haste", danger: false },
  { id: "minecraft:mining_fatigue", danger: true },
  { id: "minecraft:jump_boost", danger: false },
  { id: "minecraft:levitation", danger: true },
  { id: "minecraft:slow_falling", danger: false },
  { id: "minecraft:dolphins_grace", danger: false },

  // Combat / survival
  { id: "minecraft:strength", danger: false },
  { id: "minecraft:weakness", danger: true },
  { id: "minecraft:resistance", danger: false },
  { id: "minecraft:regeneration", danger: false },
  { id: "minecraft:absorption", danger: false },
  { id: "minecraft:health_boost", danger: false },
  { id: "minecraft:fire_resistance", danger: false },
  { id: "minecraft:water_breathing", danger: false },
  { id: "minecraft:conduit_power", danger: false },

  // Vision / senses
  { id: "minecraft:night_vision", danger: false },
  { id: "minecraft:invisibility", danger: false },
  { id: "minecraft:blindness", danger: true },
  { id: "minecraft:darkness", danger: true },
  { id: "minecraft:glowing", danger: false },
  { id: "minecraft:nausea", danger: true },

  // Status ailments (harmful)
  { id: "minecraft:poison", danger: true },
  { id: "minecraft:wither", danger: true },
  { id: "minecraft:hunger", danger: true },

  // Luck / village / omens (some may be version-dependent)
  { id: "minecraft:luck", danger: false },
  { id: "minecraft:bad_luck", danger: true },
  { id: "minecraft:bad_omen", danger: true },
  { id: "minecraft:hero_of_the_village", danger: false },

  // Instant effects (apply once when enabled)
  { id: "minecraft:instant_health", danger: true, instant: true },
  { id: "minecraft:instant_damage", danger: true, instant: true },

  // Saturation (can be very strong)
  { id: "minecraft:saturation", danger: false },
];

// Build quick lookup
const EFFECT_BY_ID = new Map(EFFECTS.map(e => [e.id, e]));

// -------------------------
// Per-player toggles
// -------------------------

// Map<playerId, Map<effectId, boolean>>
const toggles = new Map();

function getPlayerToggles(player) {
  let t = toggles.get(player.id);
  if (!t) {
    t = new Map();
    // Defaults: safe ON, danger OFF (unless dangerEnabled true, then everything ON)
    for (const e of EFFECTS) {
      const onByDefault = dangerEnabled ? true : !e.danger;
      t.set(e.id, onByDefault);
    }
    toggles.set(player.id, t);
  }
  return t;
}

// -------------------------
// Applying effects
// -------------------------

function tryAddEffect(player, effectId, amp, dur) {
  try {
    player.addEffect(effectId, dur, { amplifier: amp, showParticles: SHOW_PARTICLES });
    return true;
  } catch {
    return false;
  }
}

function applyAll(player) {
  const allowed = buildGodsteelAllowedEffects(player);
  if (allowed.size === 0) return; // not wearing any godsteel -> no effects

  const t = getPlayerToggles(player);

  for (const e of EFFECTS) {
    if (!t.get(e.id)) continue;      // player toggle off
    if (!allowed.has(e.id)) continue; // not granted by worn pieces

    // Instant effects: skip refresh loop (same as your current behavior)
    if (e.instant) continue;

    tryAddEffect(player, e.id, MAX_AMP, DURATION_TICKS);
  }
}


function applyInstantIfEnabled(player, effectId) {
  const e = EFFECT_BY_ID.get(effectId);
  if (!e || !e.instant) return;

  const t = getPlayerToggles(player);
  if (!t.get(effectId)) return;

  // This will likely kill/heal massively at MAX_AMP. That's the point of "instant".
  // If you want it gentler, lower MAX_AMP or change this to amp=0.
  tryAddEffect(player, effectId, MAX_AMP, 1);
}

// -------------------------
// Chat command UI
// -------------------------

function msg(player, text) {
  try { player.sendMessage(text); } catch {}
}

function help(player) {
  msg(player,
    "§b[FX]§r Commands:\n" +
    "§7!fx list§r\n" +
    "§7!fx on <id|all>§r\n" +
    "§7!fx off <id|all>§r\n" +
    "§7!fx danger on|off§r\n" +
    "§7!fx apply§r"
  );
}

function listFx(player) {
  const t = getPlayerToggles(player);
  msg(player, `§b[FX]§r dangerEnabled=${dangerEnabled ? "§aON" : "§cOFF"}`);
  for (const e of EFFECTS) {
    const on = t.get(e.id) ? "§aON " : "§cOFF";
    const tag = e.danger ? " §6[DANGER]" : "";
    const inst = e.instant ? " §d[INSTANT]" : "";
    msg(player, `§7-§r ${on} §f${e.id}§r${tag}${inst}`);
  }
}

function setFx(player, effectId, on) {
  const t = getPlayerToggles(player);

  if (effectId === "all") {
    for (const e of EFFECTS) {
      if (!dangerEnabled && e.danger) {
        // keep danger off unless explicitly allowed
        t.set(e.id, false);
      } else {
        t.set(e.id, on);
      }
    }
    msg(player, `§b[FX]§r set ${on ? "§aON" : "§cOFF"} for ${dangerEnabled ? "all effects" : "safe effects (danger excluded)"}.`);
    if (on) {
      applyAll(player);
      // apply instants if they were allowed (dangerEnabled)
      if (dangerEnabled) {
        for (const e of EFFECTS) if (e.instant) applyInstantIfEnabled(player, e.id);
      }
    }
    return;
  }

  if (!EFFECT_BY_ID.has(effectId)) {
    msg(player, `§c[FX] Unknown effect:§r ${effectId}`);
    return;
  }

  const meta = EFFECT_BY_ID.get(effectId);
  if (meta.danger && !dangerEnabled && on) {
    msg(player, `§6[FX] Danger effects are locked OFF by default. Run: §f!fx danger on§6 then try again.`);
    return;
  }

  t.set(effectId, on);
  msg(player, `§b[FX]§r ${effectId} -> ${on ? "§aON" : "§cOFF"}`);

  if (on) {
    if (meta.instant) applyInstantIfEnabled(player, effectId);
    else tryAddEffect(player, effectId, MAX_AMP, DURATION_TICKS);
  }
}

function setDanger(player, on) {
  dangerEnabled = on;
  msg(player, `§b[FX]§r dangerEnabled -> ${dangerEnabled ? "§aON" : "§cOFF"}`);

  // Re-initialize defaults for this player only (keeps it simple)
  toggles.delete(player.id);
  getPlayerToggles(player);

  applyAll(player);
}

function handleFxCommand(player, raw) {
  const parts = raw.trim().split(/\s+/g);
  // parts[0] is "!fx"
  const sub = (parts[1] ?? "").toLowerCase();

  if (!sub) return help(player);

  if (sub === "list") return listFx(player);
  if (sub === "apply") return applyAll(player);

  if (sub === "danger") {
    const v = (parts[2] ?? "").toLowerCase();
    if (v === "on") return setDanger(player, true);
    if (v === "off") return setDanger(player, false);
    return msg(player, "§b[FX]§r usage: !fx danger on|off");
  }

  if (sub === "on" || sub === "off") {
    const id = parts[2];
    if (!id) return msg(player, "§b[FX]§r usage: !fx on <id|all>  OR  !fx off <id|all>");
    return setFx(player, id, sub === "on");
  }

  help(player);
}

// Use beforeEvents if available; fall back to afterEvents.
function hookChat() {
  const before = world?.beforeEvents?.chatSend;
  if (before?.subscribe) {
    before.subscribe((e) => {
      const player = e.sender;
      const msgText = e.message ?? "";
      if (!msgText.startsWith("!fx")) return;
      e.cancel = true;
      handleFxCommand(player, msgText);
    });
    return;
  }

  const after = world?.afterEvents?.chatSend;
  if (after?.subscribe) {
    after.subscribe((e) => {
      const player = e.sender;
      const msgText = e.message ?? "";
      if (!msgText.startsWith("!fx")) return;
      handleFxCommand(player, msgText);
    });
    return;
  }

  // No chat hook available
  world.sendMessage("§c[FX] No chatSend event available in this API build.");
}

// -------------------------
// Init
// -------------------------

export function initEffectsLab() {
  hookChat();

  system.runInterval(() => {
    for (const p of world.getAllPlayers()) applyAll(p);
  }, INTERVAL_TICKS);

  world.sendMessage("§b[FX]§r Effects Lab loaded. Type §f!fx§r for commands.");
}

// -------------------------
// Godsteel armor gating
// -------------------------

const GODSTEEL_ARMOR = {
  head:  "chaos:godsteel_helmet",
  chest: "chaos:godsteel_chestplate",
  legs:  "chaos:godsteel_leggings",
  feet:  "chaos:godsteel_boots",
};

// Split effects per piece (tweak however you like)
const GODSTEEL_EFFECTS_BY_PIECE = {
  head: [
    "minecraft:night_vision",
    "minecraft:water_breathing",
  ],
  chest: [
    "minecraft:resistance",
    "minecraft:fire_resistance",
    "minecraft:absorption",
  ],
  legs: [
    "minecraft:speed",
    "minecraft:jump_boost",
    "minecraft:haste",
  ],
  feet: [
    "minecraft:slow_falling",
    "minecraft:dolphins_grace",
  ],
};

function getEquippable(player) {
  try { return player.getComponent("minecraft:equippable"); } catch { return null; }
}

function getEquippedId(eq, slot) {
  try {
    const item = eq?.getEquipment(slot);
    return item?.typeId ?? null;
  } catch {
    return null;
  }
}

function getGodsteelWornPieces(player) {
  const eq = getEquippable(player);
  if (!eq) return { head:false, chest:false, legs:false, feet:false };

  // Bedrock equippable slots are typically: "Head", "Chest", "Legs", "Feet"
  const headId  = getEquippedId(eq, "Head");
  const chestId = getEquippedId(eq, "Chest");
  const legsId  = getEquippedId(eq, "Legs");
  const feetId  = getEquippedId(eq, "Feet");

  return {
    head:  headId  === GODSTEEL_ARMOR.head,
    chest: chestId === GODSTEEL_ARMOR.chest,
    legs:  legsId  === GODSTEEL_ARMOR.legs,
    feet:  feetId  === GODSTEEL_ARMOR.feet,
  };
}

function buildGodsteelAllowedEffects(player) {
  const worn = getGodsteelWornPieces(player);
  const allowed = new Set();

  if (worn.head)  for (const id of (GODSTEEL_EFFECTS_BY_PIECE.head  ?? [])) allowed.add(id);
  if (worn.chest) for (const id of (GODSTEEL_EFFECTS_BY_PIECE.chest ?? [])) allowed.add(id);
  if (worn.legs)  for (const id of (GODSTEEL_EFFECTS_BY_PIECE.legs  ?? [])) allowed.add(id);
  if (worn.feet)  for (const id of (GODSTEEL_EFFECTS_BY_PIECE.feet  ?? [])) allowed.add(id);

  return allowed; // empty set if no godsteel worn
}
