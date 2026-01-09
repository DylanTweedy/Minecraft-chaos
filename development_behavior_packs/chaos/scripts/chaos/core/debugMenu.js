// scripts/chaos/core/debugMenu.js
// Extended Debugging menu for Insight Lens/Goggles
// Toggles extended debugging for specific groups (additional detail beyond basic warnings/debug)

import { ActionFormData } from "@minecraft/server-ui";
import { 
  toggleExtendedDebug, 
  getAllExtendedDebugGroups,
  getAllDebugGroups,
  getDebugGroup
} from "./debugGroups.js";

// Per-player menu state
const _menuOpen = new Map(); // playerId -> true/false

/**
 * Show extended debugging menu form for a player using ActionFormData
 */
export async function showDebugMenu(player) {
  if (!player?.id) return;
  
  try {
    const enabledGroups = getAllExtendedDebugGroups(player);
    const allGroups = getAllDebugGroups();
    
    // Validate groups array
    if (!allGroups || !Array.isArray(allGroups) || allGroups.length === 0) {
      player.sendMessage("§c[Insight] No debug groups available.");
      return;
    }
    
    // Create ActionFormData menu
    const form = new ActionFormData()
      .title("§b🧿 Extended Debug Settings")
      .body("§7Lens/Goggles enable basic debug visibility.\n§7Toggle extended debugging for additional detail per system.");
    
    // Add buttons for each debug group
    for (const group of allGroups) {
      if (!group || !group.id || !group.name) continue; // Skip invalid groups
      
      const isEnabled = enabledGroups.has(group.id);
      const status = isEnabled ? "§a✓ EXTENDED" : "§8○ Basic";
      
      // Button format: "[✓/○] Group Name"
      const buttonText = `${status} ${group.name}`;
      form.button(buttonText);
    }
    
    // Add close/cancel button
    form.button("§7[Close]");
    
    // Show form and handle response
    const response = await form.show(player);
    
    if (response.canceled) {
      return;
    }
    
    const selection = response.selection;
    
    // If last button (close) was clicked
    if (selection === allGroups.length) {
      return;
    }
    
    // Toggle the selected group
    if (selection >= 0 && selection < allGroups.length) {
      const group = allGroups[selection];
      const newState = toggleExtendedDebug(player, group.id);
      const statusText = newState ? "§aExtended" : "§7Basic";
      
      try {
        player.sendMessage(`§b[Insight] §f${group.name} §7debug: §r${statusText}`);
        
        // Show summary of all enabled extended debug groups with helpful info
        const enabledGroups = getAllExtendedDebugGroups(player);
        if (enabledGroups.size > 0) {
          const groupNames = Array.from(enabledGroups).map(id => {
            const g = allGroups.find(gr => gr.id === id);
            return g ? g.name : id;
          }).join(", ");
          player.sendMessage(`§b[Extended Debug Active] §f${groupNames}§7 (${enabledGroups.size}/${allGroups.length})`);
          player.sendMessage("§7[Tip] With Extended Debug enabled, you'll see detailed messages like:");
          player.sendMessage("§7  - Queue processing steps, route finding, transfer results");
          player.sendMessage("§7  - Entry-by-entry queue details, pathfinding stats");
          player.sendMessage("§7  - More granular timing and performance data");
        } else {
          player.sendMessage("§7[Extended Debug] No groups enabled - only basic stats visible");
          player.sendMessage("§7[Tip] Basic debug shows: main stats summary every 20 ticks");
        }
      } catch {}
      
      // Show menu again with updated status (non-blocking)
      try {
        showDebugMenu(player).catch(() => {
          // Ignore errors from recursive call
        });
      } catch {}
    }
  } catch (err) {
    // Fallback to chat if form fails
    try {
      player.sendMessage(`§c[Insight] Error: ${err?.message || "Failed to show menu"}`);
      if (err?.stack) {
        // Send truncated stack to chat for debugging
        const stack = String(err.stack).substring(0, 200);
        player.sendMessage(`§7${stack}...`);
      }
    } catch {}
  }
}

