// scripts/chaos/features/logistics/util/lens.js

export function getLensFacing(block) {
  try {
    const facing = block?.permutation?.getState("minecraft:facing_direction");
    if (typeof facing === "string" && facing.length) return facing;
  } catch (e) {
    // ignore
  }
  return null;
}

export function getLensColor(block) {
  try {
    const color = block?.permutation?.getState("chaos:lens_color");
    if (typeof color === "string" && color.length) return color;
  } catch (e) {
    // ignore
  }
  return null;
}

export function lensAllowsDir(block, dx, dy, dz) {
  const facing = getLensFacing(block);
  if (!facing) return false;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const adz = Math.abs(dz);
  if (facing === "up" || facing === "down") return ady > 0 && adx === 0 && adz === 0;
  if (facing === "east" || facing === "west") return adx > 0 && ady === 0 && adz === 0;
  if (facing === "north" || facing === "south") return adz > 0 && adx === 0 && ady === 0;
  return false;
}

export function lensFacingForAxis(axis) {
  if (axis === "y") return "up";
  if (axis === "x") return "east";
  if (axis === "z") return "south";
  return "north";
}

export function lensFacingMatchesDir(block, dx, dy, dz) {
  const facing = getLensFacing(block);
  if (!facing) return false;
  if (facing === "north") return dz < 0 && dx === 0 && dy === 0;
  if (facing === "south") return dz > 0 && dx === 0 && dy === 0;
  if (facing === "east") return dx > 0 && dy === 0 && dz === 0;
  if (facing === "west") return dx < 0 && dy === 0 && dz === 0;
  if (facing === "up") return dy > 0 && dx === 0 && dz === 0;
  if (facing === "down") return dy < 0 && dx === 0 && dz === 0;
  return false;
}

export function getLensColorFromGlassId(typeId) {
  if (!typeId || typeof typeId !== "string") return "white";
  if (typeId === "minecraft:glass" || typeId === "minecraft:tinted_glass") return "white";
  if (typeId === "minecraft:stained_glass") return "white";
  if (!typeId.endsWith("_stained_glass")) return "white";
  const color = typeId.replace("minecraft:", "").replace("_stained_glass", "");
  switch (color) {
    case "light_blue": return "light_blue";
    case "light_gray": return "light_gray";
    default: return color;
  }
}
