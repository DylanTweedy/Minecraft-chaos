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
  const currentPrismKey = data.currentPrismKey || null;
  const edgeFromKey = data.edgeFromKey || currentPrismKey || null;
  return {
    id: data.id || createOrbId(),
    itemTypeId: data.itemTypeId || "",
    count: Math.max(1, data.count | 0),
    mode: data.mode || OrbModes.ATTUNED,
    state: data.state || OrbStates.AT_PRISM,
    currentPrismKey,
    sourcePrismKey: data.sourcePrismKey || null,
    destPrismKey: data.destPrismKey || null,
    destContainerKey: data.destContainerKey || null,
    driftSinkKey: data.driftSinkKey || null,
    path: Array.isArray(data.path) ? data.path.slice() : null,
    pathIndex: Number.isFinite(data.pathIndex) ? data.pathIndex : 0,
    edgeFromKey,
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
    sourceContainerKey: data.sourceContainerKey || null,
  };
}

export function serializeOrb(orb) {
  if (!orb) return null;
  return {
    itemTypeId: orb.itemTypeId,
    count: orb.count,
    mode: orb.mode,
    edgeFromKey: orb.edgeFromKey,
    edgeToKey: orb.edgeToKey,
    progress: Number.isFinite(orb.progress) ? orb.progress : 0,
    speed: Number.isFinite(orb.speed) ? orb.speed : 1,
    hops: orb.hops | 0,
    lastHandledPrismKey: orb.lastHandledPrismKey || null,
  };
}

export function deserializeOrb(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.itemTypeId || typeof raw.itemTypeId !== "string") return null;
  const edgeFromKey = raw.edgeFromKey || raw.currentPrismKey || null;
  const edgeToKey = raw.edgeToKey || null;
  const inFlight = !!(edgeFromKey && edgeToKey);
  return createOrb({
    itemTypeId: raw.itemTypeId,
    count: raw.count,
    mode: raw.mode,
    state: inFlight ? OrbStates.IN_FLIGHT : OrbStates.AT_PRISM,
    currentPrismKey: inFlight ? null : edgeFromKey,
    edgeFromKey,
    edgeToKey,
    progress: raw.progress,
    speed: raw.speed,
    hops: raw.hops,
    lastHandledPrismKey: raw.lastHandledPrismKey,
  });
}

