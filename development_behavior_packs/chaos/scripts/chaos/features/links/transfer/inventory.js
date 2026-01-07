// scripts/chaos/features/links/transfer/inventory.js
import { ItemStack } from "@minecraft/server";
import { FURNACE_BLOCK_IDS, FURNACE_FUEL_FALLBACK_IDS, FURNACE_SLOTS } from "./config.js";
import { filterAllows, isFilterEmpty, getFilterSet } from "./filters.js";

export function getAttachedInventoryContainer(nodeBlock, dimension) {
  const info = getAttachedInventoryInfo(nodeBlock, dimension);
  return info ? info.container : null;
}

export function getAttachedInventoryInfo(nodeBlock, dimension) {
  try {
    const attachedDir = getAttachedDirectionFromStates(nodeBlock);
    if (attachedDir) {
      const adj = getNeighborBlock(nodeBlock, dimension, attachedDir);
      const c = getInventoryContainer(adj);
      if (c) return { container: c, block: adj };
    }

    const dirs = ["north", "south", "east", "west", "up", "down"];
    const hits = [];
    for (const d of dirs) {
      const adj = getNeighborBlock(nodeBlock, dimension, d);
      const c = getInventoryContainer(adj);
      if (c) hits.push({ container: c, block: adj });
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return hits[0];
    return null;
  } catch (_) {
    return null;
  }
}

export function getAttachedDirectionFromStates(block) {
  try {
    const perm = block.permutation;
    if (!perm) return null;

    try {
      const face = perm.getState("minecraft:block_face");
      if (typeof face === "string") return face;
    } catch (_) {}

    try {
      const fd = perm.getState("minecraft:facing_direction");
      if (typeof fd === "number") {
        const front = numFacingToDir(fd);
        return oppositeDir(front);
      }
    } catch (_) {}

    try {
      const cd = perm.getState("minecraft:cardinal_direction");
      if (typeof cd === "string") return oppositeDir(cd);
    } catch (_) {}

    return null;
  } catch (_) {
    return null;
  }
}

export function numFacingToDir(n) {
  switch (n) {
    case 0: return "down";
    case 1: return "up";
    case 2: return "north";
    case 3: return "south";
    case 4: return "west";
    case 5: return "east";
    default: return null;
  }
}

export function oppositeDir(dir) {
  switch (dir) {
    case "north": return "south";
    case "south": return "north";
    case "east": return "west";
    case "west": return "east";
    case "up": return "down";
    case "down": return "up";
    default: return null;
  }
}

export function getNeighborBlock(block, dimension, dir) {
  try {
    if (!block || !dimension) return null;
    const loc = block.location;
    let nx = loc.x, ny = loc.y, nz = loc.z;
    switch (dir) {
      case "north": nz -= 1; break;
      case "south": nz += 1; break;
      case "west": nx -= 1; break;
      case "east": nx += 1; break;
      case "down": ny -= 1; break;
      case "up": ny += 1; break;
      default: return null;
    }
    return dimension.getBlock({ x: nx, y: ny, z: nz });
  } catch (_) {
    return null;
  }
}

export function getInventoryContainer(block) {
  try {
    if (!block) return null;
    const inv = block.getComponent("minecraft:inventory");
    if (!inv) return null;
    const c = inv.container;
    return c || null;
  } catch (_) {
    return null;
  }
}

export function isFurnaceBlock(block) {
  try {
    return !!block && FURNACE_BLOCK_IDS.has(block.typeId);
  } catch (_) {
    return false;
  }
}

export function getFurnaceSlots(container, block) {
  if (!isFurnaceBlock(block)) return null;
  if (!container || (container.size | 0) < 3) return null;
  return FURNACE_SLOTS;
}

export function makeProbeStack(typeId) {
  try {
    return new ItemStack(typeId, 1);
  } catch (_) {
    return null;
  }
}

export function isFuelStack(stack) {
  try {
    if (!stack || typeof stack.getComponent !== "function") return false;
    if (stack.getComponent("minecraft:fuel")) return true;
    if (stack.getComponent("minecraft:burn_duration")) return true;
    if (typeof stack.getTags === "function") {
      const tags = stack.getTags();
      if (Array.isArray(tags)) {
        if (tags.includes("minecraft:is_fuel")) return true;
        if (tags.includes("minecraft:fuel")) return true;
      }
    }
    return FURNACE_FUEL_FALLBACK_IDS.has(stack.typeId);
  } catch (_) {
    return false;
  }
}

export function getSlotInsertCapacity(container, slot, typeId, maxStack) {
  try {
    if (!container) return 0;
    const it = container.getItem(slot);
    if (!it) return Math.max(1, maxStack | 0);
    if (it.typeId !== typeId) return 0;
    const max = it.maxAmount || maxStack || 64;
    return Math.max(0, max - (it.amount | 0));
  } catch (_) {
    return 0;
  }
}

export function tryInsertAmountIntoSlot(container, slot, typeId, amount, maxStack) {
  try {
    if (!container || !typeId) return false;
    let remaining = Math.max(1, amount | 0);
    if (remaining <= 0) return false;

    const max = Math.max(1, maxStack | 0);
    const it = container.getItem(slot);
    if (!it) {
      const add = Math.min(max, remaining);
      try {
        container.setItem(slot, new ItemStack(typeId, add));
        remaining -= add;
      } catch (_) {}
    } else if (it.typeId === typeId) {
      const current = it.amount | 0;
      if (current < max) {
        const add = Math.min(max - current, remaining);
        const next = (typeof it.clone === "function") ? it.clone() : it;
        next.amount = current + add;
        try {
          container.setItem(slot, next);
          remaining -= add;
        } catch (_) {}
      }
    }
    return remaining <= 0;
  } catch (_) {
    return false;
  }
}

export function tryInsertAmountForContainer(container, block, typeId, amount) {
  try {
    const slots = getFurnaceSlots(container, block);
    if (slots) {
      const probe = makeProbeStack(typeId);
      const maxStack = probe?.maxAmount || 64;
      const targetSlot = isFuelStack(probe) ? slots.fuel : slots.input;
      return tryInsertAmountIntoSlot(container, targetSlot, typeId, amount, maxStack);
    }
  } catch (_) {
    // fall through
  }
  return tryInsertAmount(container, typeId, amount);
}

export function findRandomNonEmptySlot(container) {
  try {
    const size = container.size;
    const candidates = [];
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (it && it.amount > 0) candidates.push({ slot: i, stack: it });
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  } catch (_) {
    return null;
  }
}

export function findInputSlotForContainer(container, block, filterContainer) {
  try {
    const slots = getFurnaceSlots(container, block);
    if (!slots) return findRandomMatchingSlot(container, filterContainer);
    const it = container.getItem(slots.output);
    if (!it || it.amount <= 0) return null;
    if (!filterAllows(filterContainer, it.typeId)) return null;
    return { slot: slots.output, stack: it };
  } catch (_) {
    return null;
  }
}

export function findRandomMatchingSlot(container, filterContainer) {
  try {
    if (!filterContainer || isFilterEmpty(filterContainer)) {
      return findRandomNonEmptySlot(container);
    }

    const allowed = getFilterSet(filterContainer);
    if (!allowed || allowed.size === 0) return findRandomNonEmptySlot(container);

    const size = container.size;
    const candidates = [];
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it || it.amount <= 0) continue;
      if (allowed.has(it.typeId)) candidates.push({ slot: i, stack: it });
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  } catch (_) {
    return null;
  }
}

export function getTotalCountForType(container, typeId) {
  try {
    if (!container || !typeId) return 0;
    const size = container.size;
    let total = 0;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      total += it.amount | 0;
    }
    return Math.max(0, total);
  } catch (_) {
    return 0;
  }
}

export function decrementInputSlotsForType(container, typeId, count) {
  try {
    if (!container || !typeId || count <= 0) return false;
    let remaining = count | 0;
    const size = container.size;
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      const take = Math.min(remaining, it.amount | 0);
      if (take <= 0) continue;
      if (it.amount === take) {
        if (!clearSlotSafe(container, i)) return false;
      } else {
        const dec = (typeof it.clone === "function") ? it.clone() : it;
        dec.amount = it.amount - take;
        try { container.setItem(i, dec); } catch (_) { return false; }
      }
      remaining -= take;
    }
    return remaining <= 0;
  } catch (_) {
    return false;
  }
}

export function decrementInputSlotSafe(container, slot, originalStack, count) {
  try {
    if (!container || !originalStack) return false;
    if (originalStack.amount < count) return false;

    if (originalStack.amount === count) {
      return clearSlotSafe(container, slot);
    } else {
      const dec = (typeof originalStack.clone === "function") ? originalStack.clone() : cloneAsOne(originalStack);
      dec.amount = originalStack.amount - count;
      try {
        container.setItem(slot, dec);
        return true;
      } catch (_) {
        return false;
      }
    }
  } catch (_) {
    return false;
  }
}

export function clearSlotSafe(container, slot) {
  try {
    try { container.setItem(slot, undefined); return true; } catch (_) {}
    try { container.setItem(slot, null); return true; } catch (_) {}
    try { container.setItem(slot); return true; } catch (_) {}
    return false;
  } catch (_) {
    return false;
  }
}

export function cloneAsOne(stack) {
  try {
    if (typeof stack.clone === "function") {
      const c = stack.clone();
      c.amount = 1;
      return c;
    }
  } catch (_) {}

  try {
    return new ItemStack(stack.typeId, 1);
  } catch (_) {
    return stack;
  }
}

export function canInsertOne(container, typeId) {
  try {
    const size = container.size;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || 64;
      if (it.amount < max) return true;
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (!it2) return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

export function tryInsertOne(container, oneStack) {
  try {
    if (!container || !oneStack) return false;

    const size = container.size;
    const typeId = oneStack.typeId;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;

      const max = it.maxAmount || 64;
      if (it.amount >= max) continue;

      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = Math.min(max, it.amount + 1);

      try {
        container.setItem(i, next);
        return true;
      } catch (_) {}
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      try {
        container.setItem(j, oneStack);
        return true;
      } catch (_) {}
    }

    return false;
  } catch (_) {
    return false;
  }
}

export function tryInsertAmount(container, typeId, amount) {
  try {
    if (!container || !typeId) return false;
    let remaining = Math.max(1, amount | 0);
    if (remaining <= 0) return false;

    const probe = new ItemStack(typeId, 1);
    const maxStack = probe.maxAmount || 64;
    const size = container.size;

    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || maxStack;
      if (it.amount >= max) continue;

      const add = Math.min(max - it.amount, remaining);
      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = it.amount + add;

      try {
        container.setItem(i, next);
        remaining -= add;
      } catch (_) {}
    }

    for (let j = 0; j < size && remaining > 0; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      const add = Math.min(maxStack, remaining);
      try {
        container.setItem(j, new ItemStack(typeId, add));
        remaining -= add;
      } catch (_) {}
    }

    return remaining <= 0;
  } catch (_) {
    return false;
  }
}
