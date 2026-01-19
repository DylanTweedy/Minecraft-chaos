// scripts/chaos/features/logistics/phases/10_persistInsight/persist.js
import { safeJsonParse, safeJsonStringify } from "../../persistence/serializers.js";
import {
  DP_LOGISTICS_ORBS,
  DP_LOGISTICS_PRISM_LEVELS,
  DP_LOGISTICS_DRIFT_CURSORS,
} from "../../persistence/dpKeys.js";
import { serializeOrb } from "../../state/orbs.js";

const MAX_DP_LENGTH = 32767;

function saveMapAsObject(world, key, map) {
  if (!world) return;
  const obj = {};
  for (const [k, v] of map.entries()) {
    obj[k] = v;
  }
  const raw = safeJsonStringify(obj);
  if (!raw || raw.length > MAX_DP_LENGTH) return;
  world.setDynamicProperty(key, raw);
}

export function persistState(ctx) {
  const world = ctx.world;
  const prismRegistry = ctx.services?.prismRegistry;
  const linkGraph = ctx.services?.linkGraph;

  prismRegistry?.persistIfDirty?.();
  linkGraph?.persistIfDirty?.();

  const orbs = Array.isArray(ctx.state?.orbs) ? ctx.state.orbs : [];
  const maxOrbs = Math.max(1, Number(ctx.cfg.maxPersistOrbs) || 200);
  const payload = [];
  for (let i = 0; i < orbs.length && payload.length < maxOrbs; i++) {
    const serialized = serializeOrb(orbs[i]);
    if (serialized) payload.push(serialized);
  }

  const orbsRaw = safeJsonStringify(payload);
  if (orbsRaw && orbsRaw.length <= MAX_DP_LENGTH) {
    world.setDynamicProperty(DP_LOGISTICS_ORBS, orbsRaw);
  }

  const prismCounts = ctx.state?.prismCounts;
  if (prismCounts) saveMapAsObject(world, DP_LOGISTICS_PRISM_LEVELS, prismCounts);

  const driftCursors = ctx.state?.prismState?.driftCursorByPrism;
  if (driftCursors) saveMapAsObject(world, DP_LOGISTICS_DRIFT_CURSORS, driftCursors);
}

export function loadMapFromWorld(world, key) {
  const raw = world.getDynamicProperty(key);
  const parsed = safeJsonParse(raw, {});
  const map = new Map();
  for (const [k, v] of Object.entries(parsed || {})) {
    const num = Number(v);
    if (Number.isFinite(num)) map.set(k, num | 0);
  }
  return map;
}

