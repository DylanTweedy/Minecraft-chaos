// scripts/chaos/core/insight/providers/lens.js

import { LENS_ID, DEFAULTS, isBeamId } from "../../../features/logistics/config.js";
import { getLensColor, getLensFacing } from "../../../features/logistics/util/lens.js";
import { getLensEffect } from "../../../features/logistics/systems/lensEffects.js";

const FACING_VECTORS = {
  north: { front: { dx: 0, dy: 0, dz: -1 }, back: { dx: 0, dy: 0, dz: 1 } },
  south: { front: { dx: 0, dy: 0, dz: 1 }, back: { dx: 0, dy: 0, dz: -1 } },
  east: { front: { dx: 1, dy: 0, dz: 0 }, back: { dx: -1, dy: 0, dz: 0 } },
  west: { front: { dx: -1, dy: 0, dz: 0 }, back: { dx: 1, dy: 0, dz: 0 } },
  up: { front: { dx: 0, dy: 1, dz: 0 }, back: { dx: 0, dy: -1, dz: 0 } },
  down: { front: { dx: 0, dy: -1, dz: 0 }, back: { dx: 0, dy: 1, dz: 0 } },
};

function formatBlockId(id) {
  if (!id || typeof id !== "string") return "none";
  const parts = id.split(":");
  return parts[1] || id;
}

function inspectConnection(dim, baseLoc, dir) {
  if (!dim || !baseLoc || !dir) return "none";
  try {
    const neighbor = dim.getBlock({
      x: baseLoc.x + dir.dx,
      y: baseLoc.y + dir.dy,
      z: baseLoc.z + dir.dz,
    });
    if (!neighbor) return "none";
    if (neighbor.typeId === LENS_ID) {
      return `lens(${getLensColor(neighbor) || "white"})`;
    }
    if (isBeamId(neighbor.typeId)) {
      return formatBlockId(neighbor.typeId);
    }
    return formatBlockId(neighbor.typeId);
  } catch {
    return "unknown";
  }
}

function getLensBlock(world, target) {
  try {
    const dim = world?.getDimension?.(target?.dimId);
    if (!dim || !target?.pos) return null;
    return dim.getBlock({ x: target.pos.x, y: target.pos.y, z: target.pos.z });
  } catch {
    return null;
  }
}

function describeEffect(effectId) {
  if (!effectId) return "none";
  return effectId.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

export const LensProvider = {
  id: "lens",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === LENS_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const block = getLensBlock(world, target);
    if (!block) return null;

    const color = getLensColor(block) || "white";
    const effect = getLensEffect(color);
    const facing = getLensFacing(block) || "north";
    const vectors = FACING_VECTORS[facing] || FACING_VECTORS.north;
    const baseLoc = block.location;
    const dim = block.dimension;
    const frontConn = inspectConnection(dim, baseLoc, vectors.front);
    const backConn = inspectConnection(dim, baseLoc, vectors.back);

    const auraDuration = Math.max(20, Number(DEFAULTS.lensAuraDurationTicks) || 60);
    const auraRadius = Math.max(0.25, Number(DEFAULTS.lensAuraRadius) || 0.6);
    const auraAmpPerLens = Number(DEFAULTS.lensAuraAmplifierPerLens) || 0;
    const auraAmpMax = Number(DEFAULTS.lensAuraMaxAmplifier) || 0;
    const speedBoostPerLens = Number(DEFAULTS.lensSpeedBoostPerLens) || 0;
    const speedBoostMax = Number(DEFAULTS.lensSpeedBoostMax) || 0;
    const fxBoostPerLens = Number(DEFAULTS.lensFxBoostPerLens) || 0;
    const fxBoostMax = Number(DEFAULTS.lensFxBoostMax) || 0;

    const hudLine = `Lens | ${color} | ${effect ? describeEffect(effect) : "no effect"}`;
    const chatLines = [
      `Effect ${effect ? describeEffect(effect) : "none"} applies when entities stand in the adjacent beam, not on the lens itself.`,
      `Aura: duration ${auraDuration} ticks, radius ${auraRadius} blocks, amplifier ${auraAmpPerLens.toFixed(2)} per lens (max ${auraAmpMax}).`,
      `Connections: front=${frontConn} back=${backConn} (beams side-step only through front/back; sides stay inert).`,
      `Textures: front/back share lens_front/lens_back, sides use lens_side_${color}.`,
      `Speed boost: +${(speedBoostPerLens * 100).toFixed(1)}% per lens (max ${speedBoostMax}x); FX boost: +${(fxBoostPerLens * 100).toFixed(1)}% per lens (max ${fxBoostMax}).`,
    ];

    return {
      contextKey: target.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Lens",
    };
  },
};
