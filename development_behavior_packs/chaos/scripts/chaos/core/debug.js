// scripts/chaos/core/debug.js
// Centralized debug message system
// - Errors: Shown to all players
// - Warnings & Debug: Shown only to players with Insight Lens/Goggles
// - Extended Debug: Toggleable per-group via menu for additional detail

import { world } from "@minecraft/server";
import { hasInsight, hasExtendedDebug } from "./debugGroups.js";

/**
 * Message severity levels
 */
export const Severity = {
  ERROR: "error",      // Always shown to all players
  WARNING: "warning",  // Shown to players with lens/goggles
  DEBUG: "debug",      // Shown to players with lens/goggles
  EXTENDED: "extended" // Shown only if extended debugging enabled for the group
};

/**
 * Send an error message to all players
 */
export function sendError(message, context = "") {
  try {
    const prefix = context ? `§c[Chaos] ${context}: ` : "§c[Chaos] ";
    const fullMessage = prefix + message;
    
    const players = world.getAllPlayers();
    for (const player of players) {
      try {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(fullMessage);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Send a warning message (only to players with lens/goggles)
 */
export function sendWarning(message, context = "") {
  try {
    const prefix = context ? `§e[Chaos] ${context}: ` : "§e[Chaos] ";
    const fullMessage = prefix + message;
    
    const players = world.getAllPlayers();
    for (const player of players) {
      try {
        if (!hasInsight(player)) continue;
        if (typeof player.sendMessage === "function") {
          player.sendMessage(fullMessage);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Send a debug message (only to players with lens/goggles)
 * @param {string} message - The debug message
 * @param {string} context - Optional context/module name
 * @param {string} group - Optional debug group name (for extended debugging)
 */
export function sendDebug(message, context = "", group = null) {
  try {
    const prefix = context ? `§7[Chaos] ${context}: ` : "§7[Chaos] ";
    const fullMessage = prefix + message;
    
    const players = world.getAllPlayers();
    for (const player of players) {
      try {
        if (!hasInsight(player)) continue;
        
        // If group specified, check extended debugging
        if (group && !hasExtendedDebug(player, group)) continue;
        
        if (typeof player.sendMessage === "function") {
          player.sendMessage(fullMessage);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Send an extended debug message (only to players with lens/goggles AND extended debug enabled for group)
 */
export function sendExtendedDebug(message, context = "", group) {
  if (!group) {
    // Fallback to regular debug if no group specified
    sendDebug(message, context);
    return;
  }
  
  sendDebug(message, context, group);
}

/**
 * Check if a player should see debug messages (has lens or goggles)
 */
export function shouldShowDebug(player) {
  return hasInsight(player);
}
