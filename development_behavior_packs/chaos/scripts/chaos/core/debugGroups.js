// scripts/chaos/core/debugGroups.js
// Debug visibility and extended debugging groups for Insight system
// - Lens/Goggles: Enable basic debug visibility (warnings and debug logs)
// - Extended Debug Groups: Toggle additional detail for specific systems

import { world } from "@minecraft/server";

// Dynamic property key for persistent debug settings
const DP_DEBUG_SETTINGS = "chaos:debug_settings_v1";

// Helper functions for safe JSON parsing/stringifying
function safeJsonParse(str, fallback = null) {
  try {
    if (typeof str !== "string" || !str) return fallback;
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

// Debug group definitions
const DEBUG_GROUPS = [
  { id: "transfer", name: "Transfer System", desc: "Item transfer operations and queue details" },
  { id: "prism", name: "Prism Network", desc: "Prism linking and network operations" },
  { id: "beam", name: "Beam System", desc: "Beam rendering and validation" },
  { id: "fx", name: "FX/Particles", desc: "Particle effects and spawns" },
  { id: "vision", name: "Link Vision", desc: "Visual link rendering" },
  { id: "pathfinding", name: "Pathfinding", desc: "Route finding and graph operations" },
  { id: "inventory", name: "Inventory", desc: "Reservations and balance operations" },
  { id: "cache", name: "Cache System", desc: "Cache hits, misses, and invalidations" },
];

// Per-player extended debug groups (Set<groupName>) - toggleable via menu
const _extendedDebugGroups = new Map(); // playerId -> Set<groupName>

// Cache for Insight item detection (lens or goggles - updated by observation system)
const _hasInsightCache = new Map(); // playerId -> boolean

/**
 * Check if player has Insight Lens or Goggles (basic debug visibility)
 */
export function hasInsight(player) {
  if (!player?.id) return false;
  return _hasInsightCache.get(player.id) || false;
}

/**
 * Update Insight item cache for a player (called by observation system)
 */
export function updateInsightCache(player, hasIt) {
  if (!player?.id) return;
  if (hasIt) {
    _hasInsightCache.set(player.id, true);
  } else {
    _hasInsightCache.delete(player.id);
  }
}


/**
 * Check if extended debugging is enabled for a specific group
 */
export function hasExtendedDebug(player, groupName) {
  if (!player?.id) return false;
  const pid = player.id;
  const groups = _extendedDebugGroups.get(pid);
  return groups ? groups.has(groupName) : false;
}

/**
 * Toggle extended debugging for a group
 * @returns {boolean} New state (true if enabled, false if disabled)
 */
export function toggleExtendedDebug(player, groupName) {
  if (!player?.id) return false;
  const pid = player.id;
  
  let groups = _extendedDebugGroups.get(pid);
  if (!groups) {
    groups = new Set();
    _extendedDebugGroups.set(pid, groups);
  }
  
  if (groups.has(groupName)) {
    groups.delete(groupName);
    saveDebugSettings(); // Save after change
    return false;
  } else {
    groups.add(groupName);
    saveDebugSettings(); // Save after change
    return true;
  }
}

/**
 * Get all enabled extended debug groups for a player
 */
export function getAllExtendedDebugGroups(player) {
  if (!player?.id) return new Set();
  const pid = player.id;
  const groups = _extendedDebugGroups.get(pid);
  return groups ? new Set(groups) : new Set();
}

/**
 * Get all available debug groups
 */
export function getAllDebugGroups() {
  return DEBUG_GROUPS;
}

/**
 * Get debug group info by ID
 */
export function getDebugGroup(groupId) {
  return DEBUG_GROUPS.find(g => g.id === groupId);
}

/**
 * Save debug settings to world dynamic properties
 */
function saveDebugSettings() {
  try {
    const settings = {};
    for (const [playerId, groups] of _extendedDebugGroups.entries()) {
      if (groups && groups.size > 0) {
        settings[playerId] = Array.from(groups);
      }
    }
    
    const raw = safeJsonStringify(settings);
    if (raw) {
      world.setDynamicProperty(DP_DEBUG_SETTINGS, raw);
    }
  } catch {
    // Ignore save errors - settings will persist in memory until next save
  }
}

/**
 * Load debug settings from world dynamic properties
 */
export function loadDebugSettings() {
  try {
    const raw = world.getDynamicProperty(DP_DEBUG_SETTINGS);
    const settings = safeJsonParse(raw, {});
    
    let loadedCount = 0;
    if (settings && typeof settings === "object") {
      for (const [playerId, groups] of Object.entries(settings)) {
        if (Array.isArray(groups) && groups.length > 0) {
          _extendedDebugGroups.set(playerId, new Set(groups));
          loadedCount++;
        }
      }
    }
    
    // Send confirmation to players when settings are loaded (if they have lens/goggles)
    if (loadedCount > 0) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          try {
            if (!hasInsight(player)) continue;
            
            const enabledGroups = getAllExtendedDebugGroups(player);
            if (enabledGroups.size > 0) {
              const groupNames = Array.from(enabledGroups).join(", ");
              player.sendMessage(`§b[Insight] Extended debug loaded: §f${groupNames}§b (${enabledGroups.size} group${enabledGroups.size !== 1 ? 's' : ''})`);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {
    // Ignore load errors - start with empty settings
  }
}

/**
 * Clean up temporary player state (call on player leave)
 * Note: Extended debug groups are preserved (persisted) so settings survive logout
 */
export function cleanupPlayer(playerId) {
  // Only clear temporary cache (lens/goggles detection)
  // Extended debug groups are persisted and should survive logout
  _hasInsightCache.delete(playerId);
}

// Legacy function for backwards compatibility (now checks extended debug)
export function isGroupEnabled(player, groupName) {
  return hasExtendedDebug(player, groupName);
}

// Legacy function for backwards compatibility
export function toggleGroup(player, groupName) {
  return toggleExtendedDebug(player, groupName);
}

// Legacy function for backwards compatibility
export function getAllEnabledGroups(player) {
  return getAllExtendedDebugGroups(player);
}

/**
 * Get debug group name for a block type
 */
export function getGroupForBlock(block) {
  if (!block?.typeId) return null;
  const typeId = block.typeId;
  
  // Prism blocks
  if (typeId === "chaos:prism" || typeId.startsWith("chaos:prism_")) {
    return "prism";
  }
  
  // Legacy node blocks (if still used)
  if (typeId === "chaos:extractor" || typeId === "chaos:inserter") {
    return "node";
  }
  
  // Beam blocks
  if (typeId === "chaos:beam") {
    return "beam";
  }
  
  // Crystallizer
  if (typeId === "chaos:crystallizer") {
    return "transfer"; // Crystallizer is part of transfer system
  }
  
  return null;
}
