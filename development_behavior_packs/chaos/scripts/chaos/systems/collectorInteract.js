// scripts/chaos/systems/collectorInteract.js
import { world } from "@minecraft/server";
import { COLLECTOR_ID, toggleCollectorFilter, clearCollectorFilters, getCollectorKeyFromBlock } from "../features/logistics/collectorState.js";
import { addCollectorChargeForBlock, markCollectorStateDirty } from "../features/logistics/collector.js";
import { getFluxValueForItem } from "../crystallizer.js";

const WAND_ID = "chaos:wand";

function isCollectorBlock(blockOrId) {
  if (!blockOrId) return false;
  const id = typeof blockOrId === "string" ? blockOrId : blockOrId.typeId;
  return id === COLLECTOR_ID;
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

function consumeHeldItem(player, amount) {
  try {
    const inv = player.getComponent("minecraft:inventory");
    const c = inv?.container;
    if (!c) return false;
    const slot = player.selectedSlotIndex;
    if (slot == null || slot < 0 || slot >= c.size) return false;
    const it = c.getItem(slot);
    if (!it) return false;
    const need = Math.max(1, amount | 0);
    if ((it.amount | 0) <= need) {
      c.setItem(slot, undefined);
    } else {
      it.amount = (it.amount | 0) - need;
      c.setItem(slot, it);
    }
    return true;
  } catch {
    return false;
  }
}

export function startCollectorInteract() {
  const handleInteract = (ev) => {
    try {
      if (ev?.isFirstEvent === false) return;
      const player = ev?.player ?? ev?.source;
      if (!player || player.typeId !== "minecraft:player") return;

      const block = ev?.block;
      if (!block || !isCollectorBlock(block)) return;

      const item = ev?.itemStack;
      const itemId = item?.typeId;

      if (itemId === WAND_ID) return;
      if (ev && "cancel" in ev) ev.cancel = true;

      if (player.isSneaking && (!itemId || itemId === "minecraft:air")) {
        const key = getCollectorKeyFromBlock(block);
        const cleared = key ? clearCollectorFilters(key) : false;
        if (cleared) {
          markCollectorStateDirty();
          showFeedback(player, "Collector filters cleared.");
        }
        return;
      }

      if (player.isSneaking && itemId) {
        const value = getFluxValueForItem(itemId);
        if (value > 0) {
          if (consumeHeldItem(player, 1)) {
            const added = addCollectorChargeForBlock(block, itemId, 1);
            if (added > 0) {
              markCollectorStateDirty();
              showFeedback(player, `Collector charged +${added}`);
            }
          }
          return;
        }
      }

      if (!itemId || itemId === "minecraft:air") return;
      const key = getCollectorKeyFromBlock(block);
      const result = key ? toggleCollectorFilter(key, itemId) : null;
      if (!result) return;
      markCollectorStateDirty();
      const verb = result.added ? "Added" : (result.removed ? "Removed" : "Updated");
      showFeedback(player, `Collector filter: ${verb} ${itemId} (${formatFilterCount(result.size)})`);
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
      if (brokenId !== COLLECTOR_ID) return;
      const block = ev?.block;
      if (!block) return;
      const key = getCollectorKeyFromBlock(block);
      if (key) {
        clearCollectorFilters(key);
        markCollectorStateDirty();
      }
    } catch {
      // ignore
    }
  });
}
