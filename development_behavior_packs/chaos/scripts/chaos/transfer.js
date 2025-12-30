import { ItemStack } from "@minecraft/server";
import { TRANSFER_PER_PAIR_PER_TICK } from "./constants.js";

/**
 * Attempts to move up to N items (counted as single units) from input -> output.
 * Returns number of units moved.
 */
export function transferSome(inputContainer, outputContainer, maxUnits = TRANSFER_PER_PAIR_PER_TICK) {
  let moved = 0;

  for (let i = 0; i < maxUnits; i++) {
    const oneMoved = transferOneUnit(inputContainer, outputContainer);
    if (!oneMoved) break;
    moved++;
  }

  return moved;
}

function transferOneUnit(input, output) {
  // Find first non-empty slot in input
  const inSize = input.size;

  for (let slot = 0; slot < inSize; slot++) {
    const inItem = input.getItem(slot);
    if (!inItem) continue;
    if (inItem.amount <= 0) continue;

    // Try to place 1 unit into output
    const unit = new ItemStack(inItem.typeId, 1);
    // Preserve data like name/lore/enchantments where possible:
    // (clone then set amount=1)
    try {
      const cloned = inItem.clone();
      cloned.amount = 1;
      if (tryAddToContainer(output, cloned)) {
        decrementInputSlot(input, slot, inItem);
        return true;
      }
    } catch {
      // fallback plain unit
      if (tryAddToContainer(output, unit)) {
        decrementInputSlot(input, slot, inItem);
        return true;
      }
    }

    // If we couldn't output this item, try next input slot
  }

  return false;
}

function decrementInputSlot(input, slot, inItem) {
  if (inItem.amount <= 1) {
    input.setItem(slot, undefined);
  } else {
    const newStack = inItem.clone();
    newStack.amount = inItem.amount - 1;
    input.setItem(slot, newStack);
  }
}

/**
 * Try to add an item to output container:
 * - merge into existing stacks first
 * - otherwise find empty slot
 * Returns true if fully added (1 unit in our usage).
 */
function tryAddToContainer(output, stack) {
  // 1) Merge into same type stacks if possible
  for (let i = 0; i < output.size; i++) {
    const cur = output.getItem(i);
    if (!cur) continue;
    if (cur.typeId !== stack.typeId) continue;

    // Max stack size is not exposed cleanly everywhere; many stacks cap at 64.
    // We’ll use container logic: attempt setItem with increased amount and see if it sticks.
    // Conservative approach: try up to 64.
    const newAmt = cur.amount + stack.amount;
    if (newAmt > 64) continue;

    const merged = cur.clone();
    merged.amount = newAmt;

    output.setItem(i, merged);
    return true;
  }

  // 2) Put into empty slot
  for (let i = 0; i < output.size; i++) {
    const cur = output.getItem(i);
    if (cur) continue;
    output.setItem(i, stack);
    return true;
  }

  return false;
}
