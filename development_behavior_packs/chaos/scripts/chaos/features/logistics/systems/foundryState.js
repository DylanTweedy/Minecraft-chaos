// scripts/chaos/features/logistics/systems/foundryState.js
import { world } from "@minecraft/server";
import { canonicalizePrismKey } from "../network/graph/prismKeys.js";

const DP_FOUNDRY_STATE = "chaos:foundry_state_v0_json";

let _cache = null; // key -> { flux: number, cursor: number }

function safeJsonParse(s, fallback) {
  try {
    if (typeof s !== "string" || !s) return fallback;
    const parsed = JSON.parse(s);
    return parsed ?? fallback;
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

function ensureLoaded() {
  if (_cache) return;
  const raw = world.getDynamicProperty(DP_FOUNDRY_STATE);
  const parsed = safeJsonParse(raw, {});
  _cache = {};
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      const canonical = canonicalizePrismKey(key);
      if (!canonical) continue;
      const flux = Math.max(0, Number(value?.flux) || 0);
      const cursor = Math.max(0, Number(value?.cursor) || 0);
      _cache[canonical] = { flux, cursor };
    }
  }
}

function persist() {
  const raw = safeJsonStringify(_cache || {});
  if (typeof raw !== "string") return;
  world.setDynamicProperty(DP_FOUNDRY_STATE, raw);
}

export function getFoundryState(key) {
  ensureLoaded();
  const canonical = canonicalizePrismKey(key);
  if (!canonical) return null;
  if (!_cache[canonical]) {
    _cache[canonical] = { flux: 0, cursor: 0 };
  }
  return _cache[canonical];
}

export function setFoundryState(key, state) {
  ensureLoaded();
  const canonical = canonicalizePrismKey(key);
  if (!canonical || !state) return false;
  _cache[canonical] = {
    flux: Math.max(0, Number(state.flux) || 0),
    cursor: Math.max(0, Number(state.cursor) || 0),
  };
  persist();
  return true;
}

export function addFoundryFlux(key, amount, maxFlux = Number.POSITIVE_INFINITY) {
  ensureLoaded();
  const st = getFoundryState(key);
  if (!st) return 0;
  const add = Math.max(0, Number(amount) || 0);
  const cap = Math.max(0, Number(maxFlux) || 0);
  const next = Math.min(cap, (st.flux || 0) + add);
  st.flux = next;
  persist();
  return st.flux | 0;
}

export function spendFoundryFlux(key, amount) {
  ensureLoaded();
  const st = getFoundryState(key);
  if (!st) return false;
  const need = Math.max(0, Number(amount) || 0);
  if ((st.flux || 0) < need) return false;
  st.flux = Math.max(0, (st.flux || 0) - need);
  persist();
  return true;
}

export function bumpFoundryCursor(key, length) {
  ensureLoaded();
  const st = getFoundryState(key);
  if (!st) return 0;
  const len = Math.max(1, Number(length) || 1);
  st.cursor = ((st.cursor | 0) + 1) % len;
  persist();
  return st.cursor | 0;
}

export function clearFoundryState(key) {
  ensureLoaded();
  const canonical = canonicalizePrismKey(key);
  if (!canonical || !_cache[canonical]) return false;
  delete _cache[canonical];
  persist();
  return true;
}
