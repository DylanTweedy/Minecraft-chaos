// scripts/chaos/systems/insightObservation.js
// Observation mode system for Insight Lens and Goggles
// Updates lens/goggles cache for debug visibility

import { world, system } from "@minecraft/server";
import { isHoldingLens, getTargetBlockForObservation } from "../items/insightLens.js";
import { isWearingGoggles, getTargetBlockForObservation as getGogglesTargetBlock } from "../items/insightGoggles.js";
import { renderLinkVisionForPlayer } from "../vision/linkVisionExposed.js";
import { getGroupForBlock, updateInsightCache } from "../core/debugGroups.js";
import { isPrismBlock, getPrismTier } from "../features/links/transfer/config.js";

const OBSERVATION_TICK_INTERVAL = 3; // Every 3 ticks
const MAX_OBSERVATION_DISTANCE = 32;
const LINK_VISION_BUDGET = 12; // Links per tick per player
const ACTIONBAR_THROTTLE_TICKS = 5;

// Per-player state
const _lastActionBarTick = new Map(); // playerId -> tick

/**
 * Show actionbar info for block player is looking at
 */
function showBlockInfo(player, block, nowTick) {
  const lastTick = _lastActionBarTick.get(player.id) ?? -9999;
  if ((nowTick - lastTick) < ACTIONBAR_THROTTLE_TICKS) return;
  _lastActionBarTick.set(player.id, nowTick);

  try {
    const typeId = block.typeId;
    const loc = block.location;
    const key = `${block.dimension.id}|${loc.x},${loc.y},${loc.z}`;

    if (isPrismBlock(block)) {
      // Show prism info - prisms now use separate block IDs, not states
      const tier = getPrismTier(block);
      player.onScreenDisplay.setActionBar(
        `§7[Insight] Prism Tier ${tier} at ${loc.x},${loc.y},${loc.z}`
      );
    } else if (typeId === "chaos:crystallizer") {
      // Could show crystallizer info if needed
      player.onScreenDisplay.setActionBar(
        `§7[Insight] Crystallizer at ${loc.x},${loc.y},${loc.z}`
      );
    } else {
      const groupName = getGroupForBlock(block);
      if (groupName) {
        player.onScreenDisplay.setActionBar(
          `§7[Insight] ${typeId} (${groupName}) at ${loc.x},${loc.y},${loc.z}`
        );
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Start observation mode system
 */
export function startInsightObservation() {
  system.runInterval(() => {
    const nowTick = system.currentTick;

    // Process players in batches (budgeted)
    const players = world.getAllPlayers();
    let processed = 0;
    const maxPerTick = 8; // Budget: process max 8 players per tick

    for (const player of players) {
      if (processed >= maxPerTick) break;
      if (!player || player.typeId !== "minecraft:player") continue;

      try {
        const isLensHeld = isHoldingLens(player);
        const isGogglesWorn = isWearingGoggles(player);
        
        // Update Insight item cache for debug visibility
        const hasInsightItem = isLensHeld || isGogglesWorn;
        updateInsightCache(player, hasInsightItem);

        // Observation mode: render link vision if holding lens or wearing goggles
        if (hasInsightItem) {
          // Render link vision for prisms
          renderLinkVisionForPlayer(player, nowTick, MAX_OBSERVATION_DISTANCE, LINK_VISION_BUDGET);

          // Show block info in actionbar
          const targetBlock = isLensHeld 
            ? getTargetBlockForObservation(player)
            : getGogglesTargetBlock(player);
          
          if (targetBlock) {
            const groupName = getGroupForBlock(targetBlock);
            if (groupName) {
              showBlockInfo(player, targetBlock, nowTick);
            }
          }
        }

        processed++;
      } catch {
        // ignore errors for individual players
      }
    }
  }, OBSERVATION_TICK_INTERVAL);
}
