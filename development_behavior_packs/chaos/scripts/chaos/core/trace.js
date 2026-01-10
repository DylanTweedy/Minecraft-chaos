// scripts/chaos/core/trace.js
// Single-prism trace store + per-prism state cache.
// Goal: inspect one prism at a time without global spam.

const TRACE = {
  activeKey: null,         // prismKey currently being traced
  activeSetBy: null,       // optional: player name
  activeSetTick: 0,

  // prismKey -> state
  prisms: new Map(),
};

function getOrCreate(prismKey) {
  let s = TRACE.prisms.get(prismKey);
  if (!s) {
    s = {
      prismKey,
      dirty: false,
      dirtyReason: null,
      dirtyTick: 0,

      lastScanTick: 0,
      lastScanResult: null,   // e.g. "queued", "ok", "no_item", "no_options", "pathfind_timeout"
      lastScanNote: null,     // freeform detail (item type, route, etc.)
      lastError: null,

      queueSize: 0,
      cooldownUntil: 0,
    };
    TRACE.prisms.set(prismKey, s);
  }
  return s;
}

// --- Active trace key (single global) ---

export function setTraceKey(prismKey, byPlayerName = null, nowTick = 0) {
  TRACE.activeKey = prismKey || null;
  TRACE.activeSetBy = byPlayerName || null;
  TRACE.activeSetTick = nowTick | 0;
}

export function clearTraceKey() {
  TRACE.activeKey = null;
  TRACE.activeSetBy = null;
  TRACE.activeSetTick = 0;
}

export function getTraceKey() {
  return TRACE.activeKey;
}

export function isTracing(prismKey) {
  return !!TRACE.activeKey && prismKey === TRACE.activeKey;
}

// --- Per-prism state updates ---

export function markDirty(prismKey, reason = "dirty", nowTick = 0) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.dirty = true;
  s.dirtyReason = String(reason || "dirty");
  s.dirtyTick = nowTick | 0;
}

export function clearDirty(prismKey) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.dirty = false;
  s.dirtyReason = null;
  s.dirtyTick = 0;
}

export function noteScan(prismKey, result, nowTick = 0, note = null) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.lastScanTick = nowTick | 0;
  s.lastScanResult = result ? String(result) : null;
  s.lastScanNote = note != null ? String(note) : null;
  // scanning implies we “considered” it; don’t auto-clear dirty here (caller decides)
}

export function noteError(prismKey, errMsg, nowTick = 0) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.lastError = errMsg ? String(errMsg) : "unknown";
  s.lastScanTick = nowTick | 0;
}

export function noteQueueSize(prismKey, size) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.queueSize = Math.max(0, size | 0);
}

export function noteCooldown(prismKey, cooldownUntilTick) {
  if (!prismKey) return;
  const s = getOrCreate(prismKey);
  s.cooldownUntil = Math.max(0, cooldownUntilTick | 0);
}

export function getPrismTrace(prismKey) {
  if (!prismKey) return null;
  return getOrCreate(prismKey);
}

export function formatTraceLine(prismKey, nowTick = 0) {
  const s = getPrismTrace(prismKey);
  if (!s) return null;

  const ageDirty = s.dirty ? Math.max(0, (nowTick | 0) - (s.dirtyTick | 0)) : 0;
  const ageScan = s.lastScanTick ? Math.max(0, (nowTick | 0) - (s.lastScanTick | 0)) : 0;
  const cdLeft = s.cooldownUntil ? Math.max(0, (s.cooldownUntil | 0) - (nowTick | 0)) : 0;

  const dirtyPart = s.dirty
    ? `Dirty=§aYES§r (${s.dirtyReason || "dirty"}, ${ageDirty}t ago)`
    : `Dirty=§7no§r`;

  const scanPart = s.lastScanResult
    ? `LastScan=§b${s.lastScanResult}§r (${ageScan}t ago${s.lastScanNote ? ` | ${s.lastScanNote}` : ""})`
    : `LastScan=§7none§r`;

  const queuePart = `Queue=${s.queueSize | 0}`;
  const cdPart = `Cooldown=${cdLeft}t`;

  const errPart = s.lastError ? ` Err=§c${s.lastError}§r` : "";

  return `§b[Trace]§r ${prismKey} | ${dirtyPart} | ${queuePart} | ${cdPart} | ${scanPart}${errPart}`;
}
