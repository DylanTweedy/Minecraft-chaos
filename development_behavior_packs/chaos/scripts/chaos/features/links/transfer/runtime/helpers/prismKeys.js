// scripts/chaos/features/links/transfer/runtime/helpers/prismKeys.js

export function createResolvePrismKeysFromWorld(deps) {
  const {
    getNetworkStamp,
    getCachedInputKeys,
    getCachedInputsStamp,
    setCachedInputKeys,
    setCachedInputsStamp,
    loadBeamsMap,
    world,
    cacheManager,
    isPrismBlock,
    debugEnabled,
    debugState,
  } = deps || {};

  return function resolvePrismKeysFromWorld() {
    try {
      if (typeof getNetworkStamp === "function") {
        const stamp = getNetworkStamp();
        const cachedKeys =
          (typeof getCachedInputKeys === "function") ? getCachedInputKeys() : null;
        const cachedStamp =
          (typeof getCachedInputsStamp === "function") ? getCachedInputsStamp() : null;

        if (cachedKeys && cachedStamp === stamp) return cachedKeys;

        const map = loadBeamsMap(world);
        const allKeys = Object.keys(map || {});
        const prismKeys = [];

        for (const k of allKeys) {
          const info = cacheManager.resolveBlockInfoCached(k);
          if (info && info.block && isPrismBlock(info.block)) {
            prismKeys.push(k);
          }
        }

        if (typeof setCachedInputKeys === "function") {
          setCachedInputKeys(prismKeys);
        }
        if (typeof setCachedInputsStamp === "function") {
          setCachedInputsStamp(stamp);
        }
        if (debugEnabled) debugState.inputMapReloads++;
        return prismKeys;
      }
    } catch {
      // ignore and fall through
    }

    // Fallback: no stamp available / failed
    const map = loadBeamsMap(world);
    const allKeys = Object.keys(map || {});
    const prismKeys = [];

    for (const k of allKeys) {
      const info = cacheManager.resolveBlockInfoCached(k);
      if (info && info.block && isPrismBlock(info.block)) {
        prismKeys.push(k);
      }
    }

    return prismKeys;
  };
}
