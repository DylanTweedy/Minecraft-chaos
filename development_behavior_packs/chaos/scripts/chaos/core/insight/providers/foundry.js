// scripts/chaos/core/insight/providers/foundry.js

import { FOUNDRY_ID, DEFAULTS } from "../../../features/logistics/config.js";
import { getFoundryState } from "../../../features/logistics/systems/foundryState.js";
import { getFoundryFilterList } from "../../../features/logistics/systems/foundryFilters.js";
function formatList(list = [], max = 4) {
  if (!Array.isArray(list) || list.length === 0) return "none";
  const names = list.slice(0, max).map((value) => {
    if (typeof value !== "string") return "unknown";
    const parts = value.split(":");
    return parts[1] || value;
  });
  const more = list.length > max ? ` +${list.length - max} more` : "";
  return `${names.join(", ")}${more}`;
}

function getFilterNext(list, cursor) {
  if (!Array.isArray(list) || list.length === 0) return "none";
  const idx = Math.max(0, cursor | 0) % list.length;
  const item = list[idx];
  if (!item) return "none";
  const parts = item.split(":");
  return parts[1] || item;
}

export const FoundryProvider = {
  id: "foundry",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === FOUNDRY_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const dim = world?.getDimension?.(target?.dimId);
    const block = dim?.getBlock?.(target?.pos);
    if (!block) return null;

    const key = target?.prismKey || null;
    const state = key ? getFoundryState(key) : null;
    const cursor = Math.max(0, state?.cursor | 0);
    const flux = Math.max(0, state?.flux | 0);
    const filters = getFoundryFilterList(block);

    const hudLine = `Foundry | Flux ${flux} | Filters ${filters.length}`;
    const chatLines = [
      `Filters (round-robin / direct craft via right-click): ${formatList(filters, 6)}.`,
      `Next target (cursor ${cursor}): ${getFilterNext(filters, cursor)}.`,
    ];

    const lensBonusPerLens = Number(DEFAULTS.foundryLensBonusPerLens) || 0;
    const lensBonusMax = Number(DEFAULTS.foundryLensBonusMax) || 0;
    chatLines.push(
      `Lens bonus: +${(lensBonusPerLens * 100).toFixed(1)}% per lens (max ${(lensBonusMax * 100).toFixed(1)}%).`,
      `Flux is spent per craft using the crucible value table; outputs drop as items at the foundry block.`,
      "Toggle filters by right-clicking with the desired item; sneak + empty clears the list."
    );

    if (filters.length === 0) {
      chatLines.push("Foundry is idle until filters are added.");
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Foundry",
    };
  },
};
