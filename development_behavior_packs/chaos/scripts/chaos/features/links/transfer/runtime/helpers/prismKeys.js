// scripts/chaos/features/links/transfer/runtime/helpers/prismKeys.js

export function createResolvePrismKeysFromWorld(deps) {
  const registry = deps?.prismRegistry;

  return function resolvePrismKeysFromWorld() {
    if (registry && typeof registry.resolvePrismKeys === "function") {
      return registry.resolvePrismKeys();
    }
    return [];
  };
}
