// scripts/chaos/core/insight/providers/collector.js
import { key as makeKey } from "../../../features/logistics/keys.js";
import { COLLECTOR_ID } from "../../../features/logistics/collectorState.js";
import {
  getCollectorBufferSnapshot,
  getCollectorStateForInsight,
  getCollectorOutputMode,
  getCollectorFilterMode,
  getCollectorFiltersForInsight,
  getCollectorAnchorStatus,
  getCollectorAdjacencyInfo,
} from "../../../features/logistics/collector.js";

const MAX_FILTER_LIST = 6;
const MAX_BUFFER_LIST = 6;

function formatKey(dimId, pos) {
  if (!dimId || !pos) return "unknown";
  return `${dimId}|${pos.x},${pos.y},${pos.z}`;
}

function formatTypeId(typeId) {
  if (!typeId || typeof typeId !== "string") return "none";
  const parts = typeId.split(":");
  return parts[1] || typeId;
}

function formatList(list, max) {
  const safe = Array.isArray(list) ? list : [];
  const trimmed = safe.slice(0, Math.max(0, max | 0));
  const remaining = Math.max(0, safe.length - trimmed.length);
  const suffix = remaining > 0 ? ` +${remaining} more` : "";
  return `${trimmed.join(", ")}${suffix}`;
}

function formatBufferStacks(items) {
  const entries = Object.entries(items || {})
    .map(([typeId, count]) => ({ typeId, count: Math.max(0, Number(count) || 0) }))
    .filter((e) => e.count > 0);
  entries.sort((a, b) => b.count - a.count);
  const list = entries.slice(0, MAX_BUFFER_LIST).map((e) => `${formatTypeId(e.typeId)} x${e.count}`);
  const remaining = Math.max(0, entries.length - list.length);
  const suffix = remaining > 0 ? ` +${remaining} more` : "";
  return `${list.join(" | ")}${suffix}`;
}

export const CollectorProvider = {
  id: "collector",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === COLLECTOR_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const dim = world?.getDimension?.(target?.dimId);
    const block = dim?.getBlock?.(target?.pos);
    const key = block ? makeKey(target.dimId, target.pos.x, target.pos.y, target.pos.z) : null;

    const snapshot = key ? getCollectorBufferSnapshot(key) : { total: 0, types: 0, slotsUsed: 0, slotCapacity: 0, items: {} };
    const state = key ? getCollectorStateForInsight(key) : null;

    const hudLine = `Collector | ${snapshot.total} items`;

    const chatLines = [];
    chatLines.push(`Block Collector`);
    chatLines.push(`Key ${formatKey(target.dimId, target.pos)}`);

    if (state) {
      const charge = Math.max(0, state.charge | 0);
      const maxCharge = Math.max(1, state.maxCharge | 0);
      const ready = state.readyToVacuum ? "YES" : "NO";
      const reason = state.readyReason || "";
      chatLines.push(`Charge ${charge}/${maxCharge}`);
      chatLines.push(`Cost 1 flux per item vacuumed`);
      chatLines.push(`Ready to vacuum ${ready}${reason ? ` (${reason})` : ""}`);

      const filterMode = getCollectorFilterMode();
      const filters = getCollectorFiltersForInsight(key);
      chatLines.push(`Filter mode ${filterMode}`);
      chatLines.push(`Filter count ${filters.length | 0}`);
      if (filters.length > 0) {
        chatLines.push(`Filters ${formatList(filters.map(formatTypeId), MAX_FILTER_LIST)}`);
      }

      chatLines.push(`Buffer ${snapshot.slotsUsed}/${snapshot.slotCapacity} slots (${snapshot.total} items)`);
      if (snapshot.total > 0) {
        chatLines.push(`Buffer top ${formatBufferStacks(snapshot.items)}`);
      }

      if (ctx?.enhanced && block) {
        const adj = getCollectorAdjacencyInfo(block);
        const anchor = getCollectorAnchorStatus(key);
        chatLines.push(`Adj inventories ${adj.count} (first=${formatTypeId(adj.firstType)})`);
        chatLines.push(`Anchor ${anchor.status}`);
        if (anchor.anchorKey) chatLines.push(`Anchor key ${anchor.anchorKey}`);
        chatLines.push(`Output mode ${getCollectorOutputMode()}`);

        const counters = state.counters || {};
        chatLines.push(`Vacuumed ${Math.max(0, counters.vacuumed | 0)}`);
        chatLines.push(`Inserted inv ${Math.max(0, counters.insertedInv | 0)}`);
        chatLines.push(`Handed network ${Math.max(0, counters.handedNetwork | 0)}`);
        if (state.failCounts && typeof state.failCounts === "object") {
          const failEntries = Object.entries(state.failCounts)
            .map(([reasonKey, count]) => `${reasonKey}:${Math.max(0, count | 0)}`)
            .slice(0, 6);
          if (failEntries.length > 0) chatLines.push(`Fails ${failEntries.join(" | ")}`);
        }
      }
    }

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Collector",
    };
  },
};
