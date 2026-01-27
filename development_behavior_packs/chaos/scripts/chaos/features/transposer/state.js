// scripts/chaos/features/transposer/state.js
import { world } from "@minecraft/server";
import { canonicalizePrismKey } from "../logistics/keys.js";

const DP_TRANSPOSER_STATE = "chaos:transposer_state_v1_json";
const MAX_CHARGE = 16;
const MAX_OVERCHARGE = 64;

let cache = null; // stateKey -> state
let registryAvailable = false;

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
      [DP_TRANSPOSER_STATE]: { type: "string", maxLength },
    });
    registryAvailable = true;
  } catch {
    try {
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_TRANSPOSER_STATE, maxLength)
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
        ensureLoaded();
      } catch {
        // ignore
      }
    });
  }
} catch {
  // ignore
}

function ensureLoaded() {
  if (cache) return;
  const raw = world.getDynamicProperty(DP_TRANSPOSER_STATE);
  const parsed = safeJsonParse(raw, {});
  cache = {};
  if (!parsed || typeof parsed !== "object") return;
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || typeof value !== "object") continue;
    cache[key] = normalizeState(value);
  }
}

function persist() {
  const raw = safeJsonStringify(cache || {});
  if (typeof raw !== "string") return;
  try {
    world.setDynamicProperty(DP_TRANSPOSER_STATE, raw);
    registryAvailable = true;
  } catch {
    registryAvailable = false;
  }
}

function normalizeState(state) {
  const lifetime = state?.lifetime || {};
  const failed = state?.failed || {};
  return {
    charge: Math.max(0, Number(state?.charge) || 0),
    lifetime: {
      players: Math.max(0, Number(lifetime.players) || 0),
      entities: Math.max(0, Number(lifetime.entities) || 0),
      items: Math.max(0, Number(lifetime.items) || 0),
    },
    failed: {
      NO_LINK: Math.max(0, Number(failed.NO_LINK) || 0),
      NO_CHARGE: Math.max(0, Number(failed.NO_CHARGE) || 0),
      COOLDOWN: Math.max(0, Number(failed.COOLDOWN) || 0),
      DEST_INVALID: Math.max(0, Number(failed.DEST_INVALID) || 0),
    },
    lastTeleportTick: Math.max(0, Number(state?.lastTeleportTick) || 0),
    lastTeleportCooldown: Math.max(0, Number(state?.lastTeleportCooldown) || 0),
    lastTeleportKind: typeof state?.lastTeleportKind === "string" ? state.lastTeleportKind : "unknown",
  };
}

function defaultState() {
  return {
    charge: 0,
    lifetime: { players: 0, entities: 0, items: 0 },
    failed: { NO_LINK: 0, NO_CHARGE: 0, COOLDOWN: 0, DEST_INVALID: 0 },
    lastTeleportTick: 0,
    lastTeleportCooldown: 0,
    lastTeleportKind: "unknown",
  };
}

function getSoloKey(key) {
  const canonical = canonicalizePrismKey(key);
  if (!canonical) return null;
  return `solo:${canonical}`;
}

function getPairKey(a, b) {
  const k1 = canonicalizePrismKey(a);
  const k2 = canonicalizePrismKey(b);
  if (!k1 || !k2) return null;
  const [min, max] = k1 < k2 ? [k1, k2] : [k2, k1];
  return `pair:${min}<>${max}`;
}

function getState(stateKey) {
  ensureLoaded();
  if (!stateKey) return null;
  if (!cache[stateKey]) cache[stateKey] = defaultState();
  return cache[stateKey];
}

export function getChargeLimits() {
  return {
    max: MAX_CHARGE,
    overchargeMax: MAX_OVERCHARGE,
  };
}

export function getSharedStateKey(key, linkedKey) {
  if (!key) return null;
  if (linkedKey) return getPairKey(key, linkedKey);
  return getSoloKey(key);
}

export function getSharedStateSnapshot(stateKey) {
  const st = getState(stateKey);
  if (!st) return null;
  return normalizeState(st);
}

export function addSharedCharge(stateKey, amount) {
  const st = getState(stateKey);
  if (!st) return 0;
  const add = Math.max(0, Number(amount) || 0);
  if (add <= 0) return 0;
  const cap = Math.max(MAX_OVERCHARGE, MAX_CHARGE);
  const next = Math.min(cap, (st.charge | 0) + add);
  const delta = Math.max(0, next - (st.charge | 0));
  st.charge = next;
  persist();
  return delta;
}

export function spendSharedCharge(stateKey, amount) {
  const st = getState(stateKey);
  if (!st) return false;
  const need = Math.max(0, Number(amount) || 0);
  if ((st.charge | 0) < need) return false;
  st.charge = Math.max(0, (st.charge | 0) - need);
  persist();
  return true;
}

export function recordTeleport(stateKey, kind, nowTick, cooldownTicks) {
  const st = getState(stateKey);
  if (!st) return;
  if (kind === "player") st.lifetime.players++;
  else if (kind === "item") st.lifetime.items++;
  else st.lifetime.entities++;
  st.lastTeleportTick = Math.max(0, Number(nowTick) || 0);
  st.lastTeleportCooldown = Math.max(0, Number(cooldownTicks) || 0);
  st.lastTeleportKind = kind || "unknown";
  persist();
}

export function recordFailure(stateKey, reason) {
  const st = getState(stateKey);
  if (!st) return;
  const key = String(reason || "").toUpperCase();
  if (!st.failed[key] && st.failed[key] !== 0) st.failed[key] = 0;
  st.failed[key] = Math.max(0, (st.failed[key] | 0) + 1);
  persist();
}

function mergeState(a, b) {
  const merged = defaultState();
  const stA = a ? normalizeState(a) : defaultState();
  const stB = b ? normalizeState(b) : defaultState();
  merged.charge = Math.min(MAX_OVERCHARGE, (stA.charge | 0) + (stB.charge | 0));
  merged.lifetime.players = (stA.lifetime.players | 0) + (stB.lifetime.players | 0);
  merged.lifetime.entities = (stA.lifetime.entities | 0) + (stB.lifetime.entities | 0);
  merged.lifetime.items = (stA.lifetime.items | 0) + (stB.lifetime.items | 0);
  merged.failed.NO_LINK = (stA.failed.NO_LINK | 0) + (stB.failed.NO_LINK | 0);
  merged.failed.NO_CHARGE = (stA.failed.NO_CHARGE | 0) + (stB.failed.NO_CHARGE | 0);
  merged.failed.COOLDOWN = (stA.failed.COOLDOWN | 0) + (stB.failed.COOLDOWN | 0);
  merged.failed.DEST_INVALID = (stA.failed.DEST_INVALID | 0) + (stB.failed.DEST_INVALID | 0);
  merged.lastTeleportTick = Math.max(stA.lastTeleportTick | 0, stB.lastTeleportTick | 0);
  merged.lastTeleportCooldown = Math.max(stA.lastTeleportCooldown | 0, stB.lastTeleportCooldown | 0);
  merged.lastTeleportKind = stA.lastTeleportTick >= stB.lastTeleportTick ? stA.lastTeleportKind : stB.lastTeleportKind;
  return merged;
}

export function mergeStatesOnLink(aKey, bKey) {
  ensureLoaded();
  const soloA = getSoloKey(aKey);
  const soloB = getSoloKey(bKey);
  const pair = getPairKey(aKey, bKey);
  if (!soloA || !soloB || !pair) return null;

  const merged = mergeState(cache[soloA], cache[soloB]);
  cache[pair] = merged;
  delete cache[soloA];
  delete cache[soloB];
  persist();
  return pair;
}

export function splitStateOnUnlink(aKey, bKey) {
  ensureLoaded();
  const soloA = getSoloKey(aKey);
  const soloB = getSoloKey(bKey);
  const pair = getPairKey(aKey, bKey);
  if (!soloA || !soloB || !pair) return false;
  const shared = cache[pair] ? normalizeState(cache[pair]) : defaultState();
  cache[soloA] = normalizeState(shared);
  cache[soloB] = normalizeState(shared);
  delete cache[pair];
  persist();
  return true;
}
