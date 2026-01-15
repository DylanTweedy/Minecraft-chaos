// scripts/chaos/features/links/transfer/core/inflightLocks.js
export function createInflightLockManager(cfg = {}) {
  const defaultTtl = Math.max(1, Number(cfg?.scanLockTtlTicks) || 80);
  const locks = new Map();

  function makeKey(prismKey, typeId) {
    if (!prismKey || !typeId) return null;
    return `${prismKey}|${typeId}`;
  }

  function cleanup(nowTick) {
    if (!Number.isFinite(nowTick)) return;
    for (const [key, info] of locks.entries()) {
      if (!info || info.expiresAt <= nowTick) {
        locks.delete(key);
      }
    }
  }

  function has(prismKey, typeId, nowTick) {
    const key = makeKey(prismKey, typeId);
    if (!key) return false;
    const entry = locks.get(key);
    if (!entry) return false;
    if (Number.isFinite(nowTick) && entry.expiresAt <= nowTick) {
      locks.delete(key);
      return false;
    }
    return true;
  }

  function reserve(prismKey, typeId, nowTick, ttlTicks = defaultTtl) {
    const key = makeKey(prismKey, typeId);
    if (!key) return false;
    const targetTick = Math.max(1, Math.floor(ttlTicks || defaultTtl));
    const expireAt = (Number.isFinite(nowTick) ? nowTick : 0) + targetTick;
    locks.set(key, { prismKey, typeId, expiresAt: expireAt });
    return true;
  }

  function release(prismKey, typeId) {
    const key = makeKey(prismKey, typeId);
    if (!key) return;
    locks.delete(key);
  }

  function getLocks() {
    return Array.from(locks.values());
  }

  return {
    cleanup,
    has,
    reserve,
    release,
    getLocks,
  };
}
