// scripts/chaos/features/logistics/state/orbs.js
import { OrbModes, OrbStates } from "./enums.js";

let nextOrbId = 1;

export function resetOrbIds(start = 1) {
  nextOrbId = Math.max(1, start | 0);
}

export function createOrbId() {
  return `orb_${nextOrbId++}`;
}

export function createOrb(data = {}) {
  return {
    id: data.id || createOrbId(),
    itemTypeId: data.itemTypeId || "",
    count: Math.max(1, data.count | 0),
    mode: data.mode || OrbModes.ATTUNED,
    state: data.state || OrbStates.AT_PRISM,
    currentPrismKey: data.currentPrismKey || null,
    destPrismKey: data.destPrismKey || null,
    driftSinkKey: data.driftSinkKey || null,
    path: Array.isArray(data.path) ? data.path.slice() : null,
    pathIndex: Number.isFinite(data.pathIndex) ? data.pathIndex : 0,
    edgeFromKey: data.edgeFromKey || null,
    edgeToKey: data.edgeToKey || null,
    edgeEpoch: Number.isFinite(data.edgeEpoch) ? data.edgeEpoch : 0,
    edgeLength: Number.isFinite(data.edgeLength) ? data.edgeLength : 0,
    progress: Number.isFinite(data.progress) ? data.progress : 0,
    speed: Number.isFinite(data.speed) ? data.speed : 1,
    hops: Number.isFinite(data.hops) ? data.hops : 0,
    lastHandledPrismKey: data.lastHandledPrismKey || null,
    walkingIndex: Number.isFinite(data.walkingIndex) ? data.walkingIndex : 0,
    createdAtTick: Number.isFinite(data.createdAtTick) ? data.createdAtTick : 0,
    settlePending: !!data.settlePending,
  };
}

export function serializeOrb(orb) {
  if (!orb) return null;
  return {
    id: orb.id,
    itemTypeId: orb.itemTypeId,
    count: orb.count,
    mode: orb.mode,
    state: orb.state,
    currentPrismKey: orb.currentPrismKey,
    destPrismKey: orb.destPrismKey,
    driftSinkKey: orb.driftSinkKey,
    path: Array.isArray(orb.path) ? orb.path.slice() : null,
    pathIndex: orb.pathIndex | 0,
    edgeFromKey: orb.edgeFromKey,
    edgeToKey: orb.edgeToKey,
    edgeEpoch: orb.edgeEpoch | 0,
    edgeLength: orb.edgeLength | 0,
    progress: Number.isFinite(orb.progress) ? orb.progress : 0,
    speed: Number.isFinite(orb.speed) ? orb.speed : 1,
    hops: orb.hops | 0,
    lastHandledPrismKey: orb.lastHandledPrismKey || null,
    walkingIndex: orb.walkingIndex | 0,
    createdAtTick: orb.createdAtTick | 0,
  };
}

export function deserializeOrb(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.itemTypeId || typeof raw.itemTypeId !== "string") return null;
  if (!raw.currentPrismKey || typeof raw.currentPrismKey !== "string") return null;
  return createOrb(raw);
}

