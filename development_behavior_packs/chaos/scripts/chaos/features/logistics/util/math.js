// scripts/chaos/features/logistics/util/math.js

export function clamp(value, min, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

export function clampInt(value, min, max) {
  return clamp(Math.floor(value || 0), min, max) | 0;
}

