import { FaceIndex, FaceOffsets } from "./Constants.js";

export function serializeKey(location, dimensionId) {
  return `${location.x},${location.y},${location.z},${dimensionId}`;
}

export function parseKey(key) {
  const [x, y, z, dimensionId] = key.split(",");
  return {
    location: { x: Number(x), y: Number(y), z: Number(z) },
    dimensionId,
  };
}

export function addOffset(location, offset) {
  return {
    x: location.x + offset.x,
    y: location.y + offset.y,
    z: location.z + offset.z,
  };
}

export function getAttachedLocation(nodeLocation, attachedFaceIndex) {
  const offset = FaceOffsets[attachedFaceIndex ?? FaceIndex.North];
  return addOffset(nodeLocation, offset);
}
