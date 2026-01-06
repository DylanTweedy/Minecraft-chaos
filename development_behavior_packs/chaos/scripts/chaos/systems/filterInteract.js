// scripts/chaos/systems/filterInteract.js
// Right-click node filters using dynamic properties (no block inventory required).

import { world } from "@minecraft/server";
import { toggleFilterForBlock, clearFilterForBlock } from "../features/links/filters.js";

const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

function isNodeBlock(id) {
  return id === INPUT_ID || id === OUTPUT_ID;
}

function showFeedback(player, message) {
  try {
    player.sendMessage(message);
  } catch {
    // ignore
  }
}

function formatFilterCount(count) {
  const n = Math.max(0, count | 0);
  return n === 1 ? "1 item" : `${n} items`;
}

export function startFilterInteract() {
  const handleInteract = (ev) => {
    try {
      if (ev?.isFirstEvent === false) return;

      const player = ev?.player ?? ev?.source;
      if (!player || player.typeId !== "minecraft:player") return;

      const block = ev?.block;
      if (!block || !isNodeBlock(block.typeId)) return;

      const item = ev?.itemStack;
      const itemId = item?.typeId;
      if (itemId === WAND_ID) return;

      // Prevent placement on nodes when using items to set filters.
      if (ev && "cancel" in ev) ev.cancel = true;

      if (player.isSneaking && (!itemId || itemId === "minecraft:air")) {
        const cleared = clearFilterForBlock(world, block);
        if (cleared) showFeedback(player, "Chaos filter cleared.");
        return;
      }

      if (!itemId || itemId === "minecraft:air") return;

      const result = toggleFilterForBlock(world, block, itemId);
      if (!result) return;

      const verb = result.added ? "Added" : (result.removed ? "Removed" : "Updated");
      showFeedback(player, `Chaos filter: ${verb} ${itemId} (${formatFilterCount(result.size)})`);
    } catch {
      // ignore
    }
  };

  try {
    world.beforeEvents.playerInteractWithBlock.subscribe(handleInteract);
  } catch {
    // ignore
  }

  try {
    world.beforeEvents.itemUseOn.subscribe(handleInteract);
  } catch {
    // ignore
  }

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev?.brokenBlockPermutation?.type?.id;
      if (!isNodeBlock(brokenId)) return;
      const block = ev?.block;
      if (!block) return;
      clearFilterForBlock(world, block);
    } catch {
      // ignore
    }
  });
}
