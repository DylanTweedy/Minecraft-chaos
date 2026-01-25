// scripts/chaos/core/insight/providers/vacuumHopper.js
import { getVacuumHopperBufferSnapshot } from "../../../features/logistics/vacuumBuffer.js";

const HOPPER_ID = "chaos:vacuum_hopper";

function formatBlockId(typeId) {
  if (!typeId || typeof typeId !== "string") return "none";
  const parts = typeId.split(":");
  return parts[1] || typeId;
}

function formatAdjacentSummary(block) {
  const dim = block?.dimension;
  const loc = block?.location;
  if (!dim || !loc) return { lines: [], invCount: 0 };
  const base = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };
  const dirs = [
    { label: "x+", x: 1, y: 0, z: 0 },
    { label: "x-", x: -1, y: 0, z: 0 },
    { label: "y+", x: 0, y: 1, z: 0 },
    { label: "y-", x: 0, y: -1, z: 0 },
    { label: "z+", x: 0, y: 0, z: 1 },
    { label: "z-", x: 0, y: 0, z: -1 },
  ];
  const entries = [];
  let invCount = 0;
  for (const d of dirs) {
    const b = dim.getBlock({ x: base.x + d.x, y: base.y + d.y, z: base.z + d.z });
    if (!b) {
      entries.push(`${d.label}=none`);
      continue;
    }
    const type = formatBlockId(b.typeId);
    if (!b) {
      entries.push(`${d.label}=none`);
      continue;
    }
    entries.push(`${d.label}=${type}`);
  }
  return { lines: entries, invCount };
}

export const VacuumHopperProvider = {
  id: "vacuum_hopper",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === HOPPER_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const dim = world?.getDimension?.(target?.dimId);
    const block = dim?.getBlock?.(target?.pos);
    const key = target?.prismKey || null;
    const snapshot = key ? getVacuumHopperBufferSnapshot(key) : { total: 0, types: 0 };

    const hudLine = `Vacuum Hopper | ${snapshot.total} items`;

    const chatLines = [];
    chatLines.push(`Buffer ${snapshot.total} items (${snapshot.types} types)`);

    if (ctx?.enhanced && block) {
      const adj = formatAdjacentSummary(block);
      if (adj.lines.length > 0) {
        chatLines.push(`Adj ${adj.invCount}/6 ${adj.lines.join(" | ")}`);
      }
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Vacuum Hopper",
    };
  },
};
