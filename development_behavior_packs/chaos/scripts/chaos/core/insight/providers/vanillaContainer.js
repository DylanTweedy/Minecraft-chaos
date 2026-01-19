// scripts/chaos/core/insight/providers/vanillaContainer.js

const CONTAINER_IDS = new Set([
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:ender_chest",
  "minecraft:hopper",
]);

function formatBlockLabel(id) {
  if (!id || typeof id !== "string") return "Container";
  const parts = id.split(":");
  return parts[1] ? `${parts[1].replace(/_/g, " ")}` : id;
}

function getInventoryStats(world, dimId, pos) {
  try {
    if (!world || !dimId || !pos) return null;
    const dim = world.getDimension(dimId);
    if (!dim) return null;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;
    const inv = block.getComponent?.("minecraft:inventory");
    const container = inv?.container;
    if (!container) return null;
    let filled = 0;
    for (let slot = 0; slot < container.size; slot++) {
      if (container.getItem?.(slot)) filled++;
    }
    return { size: container.size, filled };
  } catch {
    return null;
  }
}

export const VanillaContainerProvider = {
  id: "vanilla_container",
  match(ctx) {
    const target = ctx?.target;
    if (!target || target.type !== "block") return false;
    const id = target.id;
    if (!id) return false;
    return CONTAINER_IDS.has(id) || id.endsWith("_shulker_box");
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const stats = getInventoryStats(world, target?.dimId, target?.pos);
    const label = formatBlockLabel(target.id);
    const hudLine = stats
      ? `${label} ${stats.filled}/${stats.size}`
      : label;

    const chatLines = [];
    if (ctx?.enhanced && stats) {
      chatLines.push(`Slots ${stats.filled}/${stats.size}`);
    }

    return {
      contextKey: target.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: label,
    };
  },
};
