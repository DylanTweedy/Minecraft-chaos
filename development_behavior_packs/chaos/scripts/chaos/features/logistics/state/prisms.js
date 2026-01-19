// scripts/chaos/features/logistics/state/prisms.js

export function createPrismState() {
  return {
    driftCursorByPrism: new Map(),
  };
}

export function getDriftCursor(state, prismKey) {
  if (!state || !prismKey) return 0;
  return state.driftCursorByPrism.get(prismKey) || 0;
}

export function setDriftCursor(state, prismKey, value) {
  if (!state || !prismKey) return;
  state.driftCursorByPrism.set(prismKey, value | 0);
}

export function notePrismXp(levelsManager, prismKey, prismBlock, lastHandledPrismKey, orb) {
  if (!levelsManager || !prismKey || !orb) return;
  if (orb.lastHandledPrismKey === prismKey) return;
  levelsManager.notePrismPassage(prismKey, prismBlock);
  orb.lastHandledPrismKey = prismKey;
}

