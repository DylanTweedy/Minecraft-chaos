// scripts/chaos/core/insight/providers/crucible.js

import { getLensColor } from "../../../features/logistics/util/lens.js";
import { CRUCIBLE_ID, LENS_ID, DEFAULTS, isBeamId } from "../../../features/logistics/config.js";
import { CRUCIBLE_VALUE_DEFAULT } from "../../../features/logistics/data/crucibleValues.js";
import { getLogisticsDebugServices } from "../../../features/logistics/runtime/debugContext.js";

const CONNECTION_DIRS = [
  { label: "East", dx: 1, dy: 0, dz: 0 },
  { label: "West", dx: -1, dy: 0, dz: 0 },
  { label: "North", dx: 0, dy: 0, dz: -1 },
  { label: "South", dx: 0, dy: 0, dz: 1 },
  { label: "Up", dx: 0, dy: 1, dz: 0 },
  { label: "Down", dx: 0, dy: -1, dz: 0 },
];

function formatBlockId(id) {
  if (!id || typeof id !== "string") return "none";
  return id.split(":")[1] || id;
}

function inspectNeighbor(block, dir) {
  if (!block) return `${dir.label}=none`;
  try {
    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return `${dir.label}=none`;
    const neighbor = dim.getBlock({
      x: loc.x + dir.dx,
      y: loc.y + dir.dy,
      z: loc.z + dir.dz,
    });
    if (!neighbor) return `${dir.label}=none`;
    if (neighbor.typeId === LENS_ID) {
      const color = getLensColor(neighbor) || "white";
      return `${dir.label}=lens(${color})`;
    }
    if (isBeamId(neighbor.typeId)) {
      return `${dir.label}=beam`;
    }
    return `${dir.label}=${formatBlockId(neighbor.typeId)}`;
  } catch {
    return `${dir.label}=error`;
  }
}

function getHorizonSummary(block) {
  return CONNECTION_DIRS.map((dir) => inspectNeighbor(block, dir));
}

export const CrucibleProvider = {
  id: "crucible",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === CRUCIBLE_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const dim = world?.getDimension?.(target?.dimId);
    const block = dim?.getBlock?.(target?.pos);
    if (!block) return null;

    const hudLine = `Crucible | Flux default ${CRUCIBLE_VALUE_DEFAULT}`;
    const chatLines = [];
    const summary = getHorizonSummary(block);
    chatLines.push(...summary.slice(0, 3));
    chatLines.push(...summary.slice(3));

    const bonusPerLens = Number(DEFAULTS.crucibleLensBonusPerLens) || 0;
    const bonusMax = Number(DEFAULTS.crucibleLensBonusMax) || 0;
    chatLines.push(
      `Lens bonus: +${(bonusPerLens * 100).toFixed(1)}% per lens (max ${(bonusMax * 100).toFixed(1)}%).`,
      `Conversion uses EMC-style table (default ${CRUCIBLE_VALUE_DEFAULT}).`,
      "Lenses on attached beams augment the flux output; beams may only pass through front/back (no sides)."
    );

    const linkGraph = getLogisticsDebugServices()?.linkGraph;
    if (linkGraph && typeof linkGraph.getNeighbors === "function") {
      const neighbors = linkGraph.getNeighbors(target?.prismKey || "", { includePending: true }) || [];
      if (neighbors.length > 0) {
        chatLines.push(`Edges: ${neighbors.length} (best lens count ${Math.max(0, neighbors[0]?.meta?.lensCount || 0)}).`);
      } else {
        chatLines.push("Edges: none");
      }
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Crucible",
    };
  },
};
