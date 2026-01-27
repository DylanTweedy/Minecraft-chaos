// scripts/chaos/systems/foundryInteract.js
import { world } from "@minecraft/server";
import { FOUNDRY_ID } from "../features/logistics/config.js";
import { toggleFoundryFilterForBlock, clearFoundryFiltersForBlock } from "../features/logistics/systems/foundryFilters.js";
import { emitTrace } from "../core/insight/trace.js";

const WAND_ID = "chaos:wand";

function isFoundryBlock(blockOrId) {
  if (!blockOrId) return false;
  const id = typeof blockOrId === "string" ? blockOrId : blockOrId.typeId;
  return id === FOUNDRY_ID;
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

export function startFoundryInteract() {
  const handleInteract = (ev) => {
    try {
      if (ev?.isFirstEvent === false) return;
      const player = ev?.player ?? ev?.source;
      if (!player || player.typeId !== "minecraft:player") return;

      const block = ev?.block;
      if (!block || !isFoundryBlock(block)) return;

      const item = ev?.itemStack;
      const itemId = item?.typeId;

      if (itemId === WAND_ID) return;
      if (ev && "cancel" in ev) ev.cancel = true;

      if (player.isSneaking && (!itemId || itemId === "minecraft:air")) {
        const cleared = clearFoundryFiltersForBlock(block);
        if (cleared) showFeedback(player, "Foundry filter cleared.");
        emitTrace(null, "foundry", {
          text: `[Foundry] Filters cleared at ${block.location.x},${block.location.y},${block.location.z}`,
          category: "foundry",
          dedupeKey: `foundry_filters_cleared_${block.dimension.id}_${block.location.x}_${block.location.y}_${block.location.z}`,
        });
        return;
      }

      if (!itemId || itemId === "minecraft:air") return;
      const result = toggleFoundryFilterForBlock(block, itemId);
      if (!result) return;
      const verb = result.added ? "Added" : (result.removed ? "Removed" : "Updated");
      showFeedback(player, `Foundry filter: ${verb} ${itemId} (${formatFilterCount(result.size)})`);
      emitTrace(null, "foundry", {
        text: `[Foundry] ${verb} ${itemId} (${result.size})`,
        category: "foundry",
        dedupeKey: `foundry_filter_${block.dimension.id}_${block.location.x}_${block.location.y}_${block.location.z}_${itemId}`,
      });
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
      if (brokenId !== FOUNDRY_ID) return;
      const block = ev?.block;
      if (!block) return;
      clearFoundryFiltersForBlock(block);
    } catch {
      // ignore
    }
  });
}
