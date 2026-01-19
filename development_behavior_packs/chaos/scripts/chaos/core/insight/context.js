// scripts/chaos/core/insight/context.js

function ensureString(value, fallback = "unknown") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function ensureInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.floor(num);
}

export function makeBlockContextKey(dimensionId, x, y, z) {
  const dim = ensureString(dimensionId);
  const xi = ensureInt(x);
  const yi = ensureInt(y);
  const zi = ensureInt(z);
  return `block:${dim}:${xi},${yi},${zi}`;
}

export function makeEntityContextKey(dimensionId, entityId) {
  const dim = ensureString(dimensionId);
  const id = ensureString(entityId, "entity");
  return `entity:${dim}:${id}`;
}

export function makeItemContextKey(itemId) {
  return `item:${ensureString(itemId, "item")}`;
}
