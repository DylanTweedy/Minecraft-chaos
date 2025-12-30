import { system } from "@minecraft/server";
import { PENDING_TIMEOUT_TICKS } from "./constants.js";

const pendingByPlayerId = new Map();

/**
 * @param {string} playerId
 * @param {{ dimId: string, x:number, y:number, z:number, tick:number }} sel
 */
export function setPending(playerId, sel) {
  pendingByPlayerId.set(playerId, sel);
}

/** @param {string} playerId */
export function clearPending(playerId) {
  pendingByPlayerId.delete(playerId);
}

/** @param {string} playerId */
export function getPending(playerId) {
  const sel = pendingByPlayerId.get(playerId);
  if (!sel) return null;

  const age = system.currentTick - sel.tick;
  if (age > PENDING_TIMEOUT_TICKS) {
    pendingByPlayerId.delete(playerId);
    return null;
  }
  return sel;
}
