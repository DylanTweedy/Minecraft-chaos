// scripts/chaos/core/insight/trace.js

import { getInsightState } from "./state.js";
import { system } from "@minecraft/server";

const MAX_CONTEXT_MESSAGES = 32;
const MAX_GLOBAL_MESSAGES = 32;

const _contextMessages = new Map(); // contextKey -> Map(dedupeKey -> msg)
const _globalMessages = new Map(); // dedupeKey -> msg
const _pendingErrors = [];
const _errorHistory = new Map();
const ERROR_HISTORY_TICKS = 100;
const ERROR_HISTORY_LIMIT = 256;

const _prismStates = new Map(); // prismKey -> state

const DEFAULT_TICK = 0;

function getCurrentTick() {
  return Number.isFinite(system?.currentTick) ? system.currentTick : DEFAULT_TICK;
}

function pruneErrorHistory(nowTick) {
  if (!Number.isFinite(nowTick)) return;
  const expireBefore = nowTick - ERROR_HISTORY_TICKS;
  for (const [key, tick] of _errorHistory.entries()) {
    if (!Number.isFinite(tick) || tick < expireBefore) {
      _errorHistory.delete(key);
    }
    if (_errorHistory.size <= ERROR_HISTORY_LIMIT) break;
  }
}

export function emitInsightError(code, message, nowTick = null, contextKey = "") {
  if (!code || !message) return;
  const tick =
    Number.isFinite(nowTick) && nowTick >= 0
      ? nowTick
      : (system?.currentTick ?? 0);
  const dedupeKey = contextKey ? `${code}:${contextKey}` : code;
  const lastSeen = _errorHistory.get(dedupeKey);
  if (Number.isFinite(lastSeen) && tick - lastSeen < ERROR_HISTORY_TICKS) {
    return;
  }
  pruneErrorHistory(tick);
  _errorHistory.set(dedupeKey, tick);
  _pendingErrors.push({ code, message, contextKey: contextKey || null, tick });
}

export function drainInsightErrors(nowTick = 0, maxPerTick = 3) {
  if (!Array.isArray(_pendingErrors) || _pendingErrors.length === 0) return [];
  const tick = Number.isFinite(nowTick) ? nowTick : 0;
  let count = 0;
  const out = [];
  while (count < maxPerTick && _pendingErrors.length > 0) {
    const entry = _pendingErrors.shift();
    if (!entry) continue;
    out.push(entry);
    count++;
  }
  return out;
}

export function requeueInsightErrors(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i]) continue;
    _pendingErrors.unshift(entries[i]);
  }
}

function normalizeInsightResult(payload) {
  if (payload == null) return { status: null, reason: null };
  if (typeof payload === "object") {
    const status =
      payload.status != null
        ? String(payload.status)
        : payload.reason != null
        ? String(payload.reason)
        : payload.text != null
        ? String(payload.text)
        : null;
    const reason = payload.reason != null ? String(payload.reason) : null;
    return { status, reason };
  }
  return { status: String(payload), reason: null };
}

function assignPrismState(prismKey, updates) {
  if (!prismKey || !updates) return;
  const state = getOrCreatePrismState(prismKey);
  Object.assign(state, updates);
}

function upsertMessage(store, msg, limit) {
  const key = msg.dedupeKey || msg.text || "";
  if (!key) return;
  store.set(key, msg);
  if (store.size > limit) {
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
}

function normalizeMessage(channel, payload) {
  const text = payload?.text != null ? String(payload.text) : "";
  if (!text) return null;
  return {
    text,
    category: payload?.category || channel || "",
    icon: payload?.icon || "",
    severity: payload?.severity || "",
    contextKey: payload?.contextKey || null,
    dedupeKey: payload?.dedupeKey || text,
  };
}

function parseEvidence(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function emitTrace(player, channel, payload = {}) {
  const msg = normalizeMessage(channel, payload);
  if (!msg) return;

  if (player?.id) {
    const state = getInsightState(player);
    if (state) state.chatQueue.push(msg);
    return;
  }

  if (msg.contextKey) {
    let store = _contextMessages.get(msg.contextKey);
    if (!store) {
      store = new Map();
      _contextMessages.set(msg.contextKey, store);
    }
    upsertMessage(store, msg, MAX_CONTEXT_MESSAGES);
    return;
  }

  upsertMessage(_globalMessages, msg, MAX_GLOBAL_MESSAGES);
}

export function getContextMessages(contextKey) {
  if (!contextKey) return [];
  const store = _contextMessages.get(contextKey);
  if (!store) return [];
  return Array.from(store.values());
}

export function getGlobalMessages() {
  return Array.from(_globalMessages.values());
}

function getOrCreatePrismState(prismKey) {
  let s = _prismStates.get(prismKey);
  if (!s) {
    s = {
      prismKey,
      dirty: false,
      dirtyReason: null,
      dirtyTick: 0,
      lastScanTick: 0,
      lastScanResult: null,
      lastScanNote: null,
      lastScanStatus: null,
      lastScanReason: null,
      lastError: null,
      lastPathfindMs: 0,
      lastPathfindTick: 0,
      lastPathfindKind: null,
      lastTransferResult: null,
      lastTransferStatus: null,
      lastTransferReason: null,
    lastTransferTick: 0,
    queueSize: 0,
    cooldownUntil: 0,
      lastVirtualCapacity: 0,
      lastVirtualCapacityTick: 0,
      virtualCapacityReason: null,
      virtualCapacityEvidence: null,
      targetContainerFull: false,
      hasNeighborInventory: false,
      registered: false,
    };
    _prismStates.set(prismKey, s);
  }
  return s;
}

export function markDirty(prismKey, reason = "dirty", nowTick = 0) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.dirty = true;
  s.dirtyReason = String(reason || "dirty");
  s.dirtyTick = nowTick | 0;
}

export function clearDirty(prismKey) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.dirty = false;
  s.dirtyReason = null;
  s.dirtyTick = 0;
}

export function noteScan(prismKey, result, nowTick = 0, note = null) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  const normalized = normalizeInsightResult(result);
  const label = normalized.status || (result != null ? String(result) : null);
  s.lastScanTick = nowTick | 0;
  s.lastScanResult = label;
  s.lastScanStatus = label;
  s.lastScanReason = normalized.reason;
  s.lastScanNote = note != null ? String(note) : null;
}

export function noteError(prismKey, errMsg, nowTick = 0) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.lastError = errMsg ? String(errMsg) : "unknown";
  s.lastScanTick = nowTick | 0;
}

export function noteQueueSize(prismKey, size) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.queueSize = Math.max(0, size | 0);
}

export function notePathfind(prismKey, ms, nowTick = 0, kind = null) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.lastPathfindMs = Math.max(0, Number(ms) || 0);
  s.lastPathfindTick = nowTick | 0;
  s.lastPathfindKind = kind ? String(kind) : null;
}

export function noteTransferResult(prismKey, result, nowTick = 0) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  const normalized = normalizeInsightResult(result);
  const label = normalized.status || (result != null ? String(result) : null);
  s.lastTransferResult = label;
  s.lastTransferStatus = label;
  s.lastTransferReason = normalized.reason;
  s.lastTransferTick = nowTick | 0;
}

export function noteCooldown(prismKey, cooldownUntilTick) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.cooldownUntil = Math.max(0, cooldownUntilTick | 0);
}

export function noteNeighborInventories(prismKey, hasNeighbors) {
  assignPrismState(prismKey, {
    hasNeighborInventory: !!hasNeighbors,
  });
}

export function noteVirtualCapacity(prismKey, virtualCapacity = 0, targetFull = false, tick = null) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  const currentTick = Number.isFinite(tick) ? tick : getCurrentTick();
  s.lastVirtualCapacity = Math.max(0, Number(virtualCapacity) || 0);
  s.lastVirtualCapacityTick = currentTick | 0;
  s.targetContainerFull = !!targetFull;
}

export function noteVirtualCapacityReason(prismKey, reason, evidence = null) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  if (!reason) {
    s.virtualCapacityReason = null;
    s.virtualCapacityEvidence = null;
    return;
  }
  const normalizedReason = typeof reason === "string" ? reason : String(reason);
  const evidenceString =
    evidence && typeof evidence === "object" ? JSON.stringify(evidence) : evidence;
  if (
    s.virtualCapacityReason === normalizedReason &&
    s.virtualCapacityEvidence === evidenceString
  ) {
    return;
  }
  s.virtualCapacityReason = normalizedReason;
  s.virtualCapacityEvidence = evidenceString;
}

export function notePrismRegistryStatus(prismKey, registered = false) {
  const updates = { registered: !!registered };
  if (!registered) {
    updates.lastRegistrySource = null;
  }
  assignPrismState(prismKey, updates);
}

export function notePrismRegistrySource(prismKey, source) {
  if (!prismKey) return;
  const s = getOrCreatePrismState(prismKey);
  s.lastRegistrySource = source ? String(source) : null;
}

export function getPrismRegistrySource(prismKey) {
  if (!prismKey) return null;
  const s = _prismStates.get(prismKey);
  return s?.lastRegistrySource || null;
}

export function getRegisteredPrismKeys() {
  const keys = [];
  for (const [k, state] of _prismStates.entries()) {
    if (state?.registered) keys.push(k);
  }
  return keys;
}

export function getPrismDiagnostics(prismKey) {
  if (!prismKey) return null;
  const s = _prismStates.get(prismKey);
  if (!s) return null;
  return {
    scanStatus: s.lastScanStatus,
    scanReason: s.lastScanReason,
    transferStatus: s.lastTransferStatus,
    transferReason: s.lastTransferReason,
    virtualCapacity: s.lastVirtualCapacity,
    virtualCapacityTick: s.lastVirtualCapacityTick,
    virtualCapacityReason: s.virtualCapacityReason || null,
    virtualCapacityEvidence: parseEvidence(s.virtualCapacityEvidence),
    targetContainerFull: s.targetContainerFull,
    neighborInventory: s.hasNeighborInventory,
    registered: s.registered,
    queueSize: s.queueSize,
    lastScanNote: s.lastScanNote,
    registrySource: s.lastRegistrySource,
  };
}

export function getPrismTrace(prismKey) {
  if (!prismKey) return null;
  return getOrCreatePrismState(prismKey);
}

export function isPrismRegistered(prismKey) {
  if (!prismKey) return false;
  const s = _prismStates.get(prismKey);
  return !!s?.registered;
}

export function hasAnyRegisteredPrism() {
  for (const state of _prismStates.values()) {
    if (state?.registered) return true;
  }
  return false;
}

export function getFirstRegisteredPrismKey() {
  for (const [key, state] of _prismStates.entries()) {
    if (state?.registered) return key;
  }
  return null;
}
