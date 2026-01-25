// scripts/chaos/core/insight/providers/teleporter.js
import { getLinkedKey } from "../../../features/teleporter/pairs.js";
import { parseKey } from "../../../features/logistics/keys.js";

const TELEPORTER_ID = "chaos:teleporter";

function formatPos(parsed) {
  if (!parsed) return "unknown";
  return `${parsed.dimId} ${parsed.x},${parsed.y},${parsed.z}`;
}

function getBlockAt(world, dimId, pos) {
  try {
    if (!world || !dimId || !pos) return null;
    const dim = world.getDimension(dimId);
    if (!dim) return null;
    return dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
  } catch {
    return null;
  }
}

export const TeleporterProvider = {
  id: "teleporter",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === TELEPORTER_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const key = target?.prismKey || null;
    const linked = key ? getLinkedKey(key) : null;
    const linkedParsed = linked ? parseKey(linked) : null;
    const linkedBlock = linkedParsed
      ? getBlockAt(world, linkedParsed.dimId, linkedParsed)
      : null;
    const linkedOk = !!linkedBlock && linkedBlock.typeId === TELEPORTER_ID;

    const hudLine = linked
      ? `Teleporter | Linked ${linkedOk ? "OK" : "Missing"}`
      : "Teleporter | Unlinked";

    const chatLines = [];
    if (linked) {
      chatLines.push(`Link ${formatPos(linkedParsed)}`);
      chatLines.push(`Status ${linkedOk ? "OK" : "Missing"}`);
    } else {
      chatLines.push("Link none");
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Teleporter",
    };
  },
};
