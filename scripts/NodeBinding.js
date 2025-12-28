import { world } from "@minecraft/server";
import { BlockIds, CrystalBindRadius, DynamicPropertyIds, FaceIndex, OppositeFace } from "./Constants.js";
import { parseKey, serializeKey } from "./PositionUtils.js";
import {
  getCrystals,
  registerCrystal,
  registerNode,
  rebindNode,
  unregisterCrystalByKey,
  unregisterNode,
} from "./Registry.js";
import { spawnBeam } from "./Visuals.js";

function faceToIndex(face) {
  switch (face) {
    case "Down":
      return FaceIndex.Down;
    case "Up":
      return FaceIndex.Up;
    case "North":
      return FaceIndex.North;
    case "South":
      return FaceIndex.South;
    case "West":
      return FaceIndex.West;
    case "East":
      return FaceIndex.East;
    default:
      return FaceIndex.North;
  }
}

function setAttachedFace(nodeBlock, face) {
  const attachedFace = OppositeFace[faceToIndex(face)];
  nodeBlock.setDynamicProperty(DynamicPropertyIds.AttachedFace, attachedFace);
  try {
    const updated = nodeBlock.permutation.withState("chaos:attached_face", attachedFace);
    nodeBlock.setPermutation(updated);
  } catch (error) {
    // Ignore if state is unavailable on this runtime.
  }
}

function findNearestCrystal(nodeBlock) {
  const radius = CrystalBindRadius;
  const dimension = nodeBlock.dimension;
  const origin = nodeBlock.location;
  let bestKey = undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const knownCrystals = Array.from(getCrystals().keys());
  if (knownCrystals.length > 0) {
    knownCrystals.forEach((crystalKey) => {
      const { location, dimensionId } = parseKey(crystalKey);
      if (dimensionId !== dimension.id) {
        return;
      }
      const dx = location.x - origin.x;
      const dy = location.y - origin.y;
      const dz = location.z - origin.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq <= radius * radius && distanceSq < bestDistance) {
        bestDistance = distanceSq;
        bestKey = crystalKey;
      }
    });
    return bestKey;
  }

  for (let x = -radius; x <= radius; x += 1) {
    for (let y = -radius; y <= radius; y += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const candidate = dimension.getBlock({
          x: origin.x + x,
          y: origin.y + y,
          z: origin.z + z,
        });
        if (!candidate || candidate.typeId !== BlockIds.ChaosCrystal) {
          continue;
        }
        const distanceSq = x * x + y * y + z * z;
        if (distanceSq < bestDistance) {
          bestDistance = distanceSq;
          bestKey = serializeKey(candidate.location, dimension.id);
        }
      }
    }
  }
  return bestKey;
}

function bindNode(nodeBlock, face) {
  const nodeType = nodeBlock.typeId;
  if (nodeType !== BlockIds.ChaosInputNode && nodeType !== BlockIds.ChaosOutputNode) {
    return;
  }

  if (face) {
    setAttachedFace(nodeBlock, face);
  }

  const crystalKey = findNearestCrystal(nodeBlock);
  if (!crystalKey) {
    const nodeKey = serializeKey(nodeBlock.location, nodeBlock.dimension.id);
    unregisterNode(nodeKey);
    nodeBlock.setDynamicProperty(DynamicPropertyIds.BoundCrystal, undefined);
    return;
  }

  const nodeKey = serializeKey(nodeBlock.location, nodeBlock.dimension.id);
  const currentKey = nodeBlock.getDynamicProperty(DynamicPropertyIds.BoundCrystal);
  if (typeof currentKey === "string" && currentKey !== crystalKey) {
    rebindNode(nodeKey, crystalKey, nodeType);
  } else {
    registerNode(nodeKey, crystalKey, nodeType);
  }
  nodeBlock.setDynamicProperty(DynamicPropertyIds.BoundCrystal, crystalKey);

  const { location: crystalLocation } = parseKey(crystalKey);
  spawnBeam(nodeBlock.dimension, nodeBlock.location, crystalLocation);
}

export function initializeNodeBinding() {
  world.afterEvents.blockPlace.subscribe((event) => {
    const block = event.block;
    if (!block) {
      return;
    }
    if (block.typeId === BlockIds.ChaosCrystal) {
      registerCrystal(block);
      return;
    }
    if (block.typeId === BlockIds.ChaosInputNode || block.typeId === BlockIds.ChaosOutputNode) {
      bindNode(block, event.face);
    }
  });

  world.afterEvents.blockBreak.subscribe((event) => {
    const brokenType = event.brokenBlockPermutation?.type?.id;
    const location = event.blockLocation ?? event.block?.location;
    const dimension = event.dimension ?? event.block?.dimension;
    if (!location || !dimension) {
      return;
    }
    const blockKey = serializeKey(location, dimension.id);
    if (brokenType === BlockIds.ChaosCrystal) {
      unregisterCrystalByKey(blockKey);
      return;
    }
    if (brokenType === BlockIds.ChaosInputNode || brokenType === BlockIds.ChaosOutputNode) {
      unregisterNode(blockKey);
    }
  });

  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    if (!block) {
      return;
    }
    if (block.typeId === BlockIds.ChaosInputNode || block.typeId === BlockIds.ChaosOutputNode) {
      bindNode(block);
    }
  });

  world.afterEvents.entityHitBlock.subscribe((event) => {
    const block = event.block;
    if (!block) {
      return;
    }
    if (block.typeId === BlockIds.ChaosInputNode || block.typeId === BlockIds.ChaosOutputNode) {
      bindNode(block);
    }
  });
}
