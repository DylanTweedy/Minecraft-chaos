import { ItemStack } from "@minecraft/server";
import { DynamicPropertyIds, FaceIndex, FaceOffsets } from "./Constants.js";
import { addOffset } from "./PositionUtils.js";

export function getFilterSet(nodeBlock) {
  const inventory = nodeBlock.getComponent("inventory");
  if (!inventory) {
    return new Set();
  }
  const allowed = new Set();
  const container = inventory.container;
  for (let slot = 0; slot < container.size; slot += 1) {
    const item = container.getItem(slot);
    if (item) {
      allowed.add(item.typeId);
    }
  }
  return allowed;
}

export function getAttachedFaceIndex(nodeBlock) {
  const storedFace = nodeBlock.getDynamicProperty(DynamicPropertyIds.AttachedFace);
  if (typeof storedFace === "number") {
    return storedFace;
  }

  try {
    const permutationFace = nodeBlock.permutation.getState("chaos:attached_face");
    if (typeof permutationFace === "number") {
      return permutationFace;
    }
  } catch (error) {
    return FaceIndex.North;
  }

  return FaceIndex.North;
}

export function getAttachedBlock(nodeBlock) {
  const faceIndex = getAttachedFaceIndex(nodeBlock);
  const offset = FaceOffsets[faceIndex];
  const attachedLocation = addOffset(nodeBlock.location, offset);
  return nodeBlock.dimension.getBlock(attachedLocation);
}

export function getAttachedContainer(nodeBlock) {
  const attachedBlock = getAttachedBlock(nodeBlock);
  if (!attachedBlock) {
    return undefined;
  }
  const inventory = attachedBlock.getComponent("inventory");
  if (!inventory) {
    return undefined;
  }
  return inventory.container;
}

export function findExtractableItem(container, allowedSet) {
  const allowAll = allowedSet.size === 0;
  for (let slot = 0; slot < container.size; slot += 1) {
    const item = container.getItem(slot);
    if (!item) {
      continue;
    }
    if (allowAll || allowedSet.has(item.typeId)) {
      return { slot, item };
    }
  }
  return undefined;
}

export function extractOne(container, slot, item) {
  const extracted = new ItemStack(item.typeId, 1);
  if (item.amount <= 1) {
    container.setItem(slot, undefined);
  } else {
    const remaining = item.clone();
    remaining.amount = item.amount - 1;
    container.setItem(slot, remaining);
  }
  return extracted;
}

export function canInsertItem(container, item, allowedSet) {
  const allowAll = allowedSet.size === 0;
  if (!allowAll && !allowedSet.has(item.typeId)) {
    return false;
  }

  for (let slot = 0; slot < container.size; slot += 1) {
    const current = container.getItem(slot);
    if (!current) {
      return true;
    }
    if (current.typeId === item.typeId && current.amount < current.maxAmount) {
      return true;
    }
  }
  return false;
}

export function insertOne(container, item) {
  for (let slot = 0; slot < container.size; slot += 1) {
    const current = container.getItem(slot);
    if (!current) {
      container.setItem(slot, item);
      return true;
    }
    if (current.typeId === item.typeId && current.amount < current.maxAmount) {
      const updated = current.clone();
      updated.amount = current.amount + 1;
      container.setItem(slot, updated);
      return true;
    }
  }
  return false;
}
