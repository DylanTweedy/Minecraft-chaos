// scripts/chaos/state.js
import { system } from "@minecraft/server";

// 60 seconds @ 20tps
const TIMEOUT_TICKS = 20 * 60;

// playerId -> pending
// pending = { type: "input"|"output", dimId, x, y, z, tick }
const pendingByPlayer = new Map();

export function setPending(playerId, pending) {
  pendingByPlayer.set(playerId, pending);
}

export function clearPending(playerId) {
  pendingByPlayer.delete(playerId);
}

export function getPending(playerId) {
  const p = pendingByPlayer.get(playerId);
  if (!p) return null;

  // Expire
  const age = system.currentTick - (p.tick ?? system.currentTick);
  if (age > TIMEOUT_TICKS) {
    pendingByPlayer.delete(playerId);
    return null;
  }

  return p;
}
