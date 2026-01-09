// scripts/chaos/core/scriptLoader.js
// Tracks script loading status and sends messages to players

import { hasInsight } from "./debugGroups.js";
import { isWearingGoggles } from "../items/insightGoggles.js";

// Script loading status tracking
const scriptStatus = {
  total: 0,
  loaded: 0,
  scripts: new Map(), // scriptName -> { loaded: boolean, name: string }
};

// Track which players have been notified (to avoid spam on reload)
const notifiedPlayers = new Set();

// Store world and system references (set after initialization)
let worldRef = null;
let systemRef = null;

// Track if player join notifier is already running
let notifierIntervalId = null;

/**
 * Register a script that needs to be tracked
 */
export function registerScript(scriptName) {
  if (!scriptStatus.scripts.has(scriptName)) {
    scriptStatus.scripts.set(scriptName, { loaded: false, name: scriptName });
    scriptStatus.total++;
  }
}

/**
 * Mark a script as loaded
 */
export function markScriptLoaded(scriptName) {
  const script = scriptStatus.scripts.get(scriptName);
  if (script && !script.loaded) {
    script.loaded = true;
    scriptStatus.loaded++;
  }
}

/**
 * Get loading status
 */
export function getLoadingStatus() {
  return {
    loaded: scriptStatus.loaded,
    total: scriptStatus.total,
    percentage: scriptStatus.total > 0 ? Math.floor((scriptStatus.loaded / scriptStatus.total) * 100) : 100,
  };
}

/**
 * Send loading status message to a player (only if wearing goggles or has debug groups)
 * Returns true if message was sent, false otherwise
 */
function sendStatusToPlayer(player) {
  try {
    if (!player || !player.isValid()) return false;
    
    // Check if player has lens or goggles (basic debug visibility)
    if (!hasInsight(player)) return false;
    
    const status = getLoadingStatus();
    const message = `§7[Chaos] Scripts loaded: §f${status.loaded}§7 / §f${status.total}§7 (${status.percentage}%)`;
    
    player.sendMessage(message);
    return true;
  } catch {
    // Ignore errors
    return false;
  }
}

/**
 * Initialize script loader with world and system references
 */
export function initializeScriptLoader(world, system) {
  worldRef = world;
  systemRef = system;
}

/**
 * Notify all players with debug enabled about loading status
 * Returns true if any players were notified
 */
export function notifyPlayers() {
  if (!worldRef) return false;
  let notified = false;
  try {
    const players = worldRef.getAllPlayers();
    for (const player of players) {
      try {
        const wasNotified = sendStatusToPlayer(player);
        if (wasNotified) notified = true;
      } catch {
        // Ignore errors for individual players
      }
    }
  } catch {
    // Ignore errors
  }
  return notified;
}

/**
 * Check for new players and notify them
 */
export function startPlayerJoinNotifier() {
  if (!worldRef || !systemRef) return;
  
  // Prevent multiple intervals from being created
  if (notifierIntervalId !== null) return;
  
  notifierIntervalId = systemRef.runInterval(() => {
    try {
      const players = worldRef.getAllPlayers();
      for (const player of players) {
        try {
          if (!player || !player.isValid()) continue;
          
          // Check if we've already notified this player
          const playerId = player.id;
          if (notifiedPlayers.has(playerId)) continue;
          
          // Check if player has lens or goggles (basic debug visibility)
          // Give it a few ticks for the observation system to update cache
          if (!hasInsight(player)) continue;
          
          // Mark as notified
          notifiedPlayers.add(playerId);
          
          // Send status after a delay (so they're fully loaded and observation system has run)
          systemRef.runTimeout(() => {
            try {
              if (player && player.isValid()) {
                sendStatusToPlayer(player);
              }
            } catch {
              // Ignore errors
            }
          }, 30); // 1.5 second delay - gives observation system time to update groups
        } catch {
          // Ignore errors for individual players
        }
      }
    } catch {
      // Ignore errors
    }
  }, 20); // Check every 1 second (more frequent to catch players faster)
}

/**
 * Clear notified players (useful on reload)
 */
export function clearNotifiedPlayers() {
  notifiedPlayers.clear();
  // Reset interval ID so it can be restarted
  notifierIntervalId = null;
}
