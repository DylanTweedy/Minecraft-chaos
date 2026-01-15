// scripts/chaos/features/armor/autoElytraSwap.js
//
// Auto Elytra Swap (swap-only, no effects)
// - When player leaves the ground while wearing an eligible chestplate, equip Elytra.
// - When player is back on ground, restore the original chestplate.
//
// This version intentionally avoids MinecraftEffectTypes / EffectTypes imports
// to stay compatible with older Script API builds.

import {
  world,
  system,
  ItemStack,
  EquipmentSlot,
  EntityComponentTypes,
} from "@minecraft/server";

// ✅ Put your eligible chestplates here
const ELIGIBLE_CHESTPLATES = new Set([
  "chaos:godsteel_chestplate",
]);

const INTERVAL_TICKS = 2;        // fast enough to catch jumps reliably
const COOLDOWN_TICKS = 10;       // prevents rapid swap jitter

// Runtime state (non-persistent)
const StateByPlayerId = new Map(); // id -> { active, storedTypeId, cooldownUntilTick }
const WasOnGroundByPlayerId = new Map(); // id -> boolean

function getTick() {
  try { return world.getAbsoluteTime(); } catch { return 0; }
}

function safeBool(readFn, fallback = false) {
  try { return !!readFn(); } catch { return fallback; }
}

function getEquippable(player) {
  try {
    return player.getComponent(EntityComponentTypes.Equippable);
  } catch {
    return undefined;
  }
}

function getChestItem(player) {
  const eq = getEquippable(player);
  if (!eq) return undefined;
  try {
    return eq.getEquipment(EquipmentSlot.Chest);
  } catch {
    return undefined;
  }
}

function setChestItem(player, itemStackOrUndefined) {
  const eq = getEquippable(player);
  if (!eq) return false;
  try {
    eq.setEquipment(EquipmentSlot.Chest, itemStackOrUndefined);
    return true;
  } catch {
    return false;
  }
}

function makeElytra() {
  return new ItemStack("minecraft:elytra", 1);
}

function isEligibleChest(item) {
  return !!item && ELIGIBLE_CHESTPLATES.has(item.typeId);
}

function isElytra(item) {
  return !!item && item.typeId === "minecraft:elytra";
}

function getPlayerState(player) {
  const id = player.id;
  if (!StateByPlayerId.has(id)) {
    StateByPlayerId.set(id, {
      active: false,
      storedTypeId: null,
      cooldownUntilTick: 0,
    });
  }
  return StateByPlayerId.get(id);
}

function justLeftGround(player) {
  const id = player.id;
  const onGround = safeBool(() => player.isOnGround, true);
  const prev = WasOnGroundByPlayerId.get(id);
  WasOnGroundByPlayerId.set(id, onGround);
  return prev === true && onGround === false;
}

function tickPlayer(player) {
  const state = getPlayerState(player);
  const t = getTick();

  // Respect cooldown
  if (t < (state.cooldownUntilTick | 0)) return;

  const chest = getChestItem(player);

  // If active, restore on landing
  if (state.active) {
    const onGround = safeBool(() => player.isOnGround, false);
    if (onGround) {
      // Restore chestplate (only if chest is currently elytra; if not, we still restore)
      if (state.storedTypeId) {
        setChestItem(player, new ItemStack(state.storedTypeId, 1));
      }
      state.active = false;
      state.storedTypeId = null;
      state.cooldownUntilTick = t + COOLDOWN_TICKS;
    } else {
      // If someone removed elytra mid-air, try to put it back
      if (!isElytra(chest)) {
        setChestItem(player, makeElytra());
        state.cooldownUntilTick = t + 2; // tiny cooldown
      }
    }
    return;
  }

  // Not active: trigger when leaving ground with eligible chestplate
  if (justLeftGround(player) && isEligibleChest(chest)) {
    state.active = true;
    state.storedTypeId = chest.typeId;
    state.cooldownUntilTick = t + COOLDOWN_TICKS;

    setChestItem(player, makeElytra());
    return;
  }
}

// Public init
export function initAutoElytraSwap() {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      tickPlayer(player);
    }
  }, INTERVAL_TICKS);
}
