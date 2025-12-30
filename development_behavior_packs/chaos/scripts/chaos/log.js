import { world } from "@minecraft/server";
import { LOG_TAG } from "./constants.js";

export function log(msg) {
  // Shows in Content Log + (optionally) chat if you want later.
  console.warn(`${LOG_TAG} ${msg}`);
}

export function tell(player, msg) {
  try {
    player.sendMessage(`${LOG_TAG} ${msg}`);
  } catch {
    // ignore
  }
}

export function broadcast(msg) {
  try {
    world.sendMessage(`${LOG_TAG} ${msg}`);
  } catch {
    // ignore
  }
}
