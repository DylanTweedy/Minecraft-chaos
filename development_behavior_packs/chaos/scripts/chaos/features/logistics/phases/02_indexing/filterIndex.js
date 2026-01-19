// scripts/chaos/features/logistics/phases/02_indexing/filterIndex.js

export function rebuildFilterIndex(ctx) {
  const filterIndex = ctx.services?.filterIndex;
  const cfg = ctx.cfg || {};
  if (!filterIndex || typeof filterIndex.rebuild !== "function") return null;
  const interval = Math.max(1, Number(cfg.filterIndexRebuildTicks || 60) | 0);
  filterIndex.rebuild(ctx.nowTick | 0, { intervalTicks: interval });
  ctx.indexes.filterIndex = filterIndex;
  return filterIndex;
}

