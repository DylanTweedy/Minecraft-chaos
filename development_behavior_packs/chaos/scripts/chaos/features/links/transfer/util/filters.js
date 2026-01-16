// scripts/chaos/features/links/transfer/runtime/helpers/filters.js

export function createGetFilterForBlock(deps) {
  const { world, getFilterContainer, getFilterSetForBlock } = deps || {};

  return function getFilterForBlock(block) {
    try {
      const c = getFilterContainer(block);
      if (c) return c;
      return getFilterSetForBlock(world, block);
    } catch {
      return null;
    }
  };
}
