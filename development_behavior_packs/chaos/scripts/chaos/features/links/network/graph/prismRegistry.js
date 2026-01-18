// scripts/chaos/features/links/transfer/runtime/registry/prismRegistry.js
import { isPrismBlock } from "../../transfer/config.js";
import { key, parseKey, prismKeyFromBlock } from "../../transfer/keys.js";
import { loadPrismRegistry, savePrismRegistry } from "../../transfer/persistence/storage.js";
import {
  notePrismRegistryStatus,
  notePrismRegistrySource,
} from "../../../../core/insight/trace.js";

const BLOCK_MISS_THRESHOLD = 10;

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v | 0));
}

export function createPrismRegistry(deps) {
  const world = deps?.world;
  const cfg = deps?.cfg || {};
  const emitInsightError = deps?.emitInsightError;

  const prisms = new Set();
  const validationQueue = [];
  const validationQueued = new Set();
  const missingBlockCounts = new Map();

  let dirty = false;
  let seedScanActive = false;
  let seedScanCenters = [];
  let seedScanCenterIndex = 0;
  let seedScanIndex = 0;

  function markDirty() {
    dirty = true;
  }

  function emitRegistryError(code, message, nowTick, prismKey) {
    if (typeof emitInsightError !== "function") return;
    emitInsightError(code, message, nowTick, prismKey);
  }

  function isValidParsedKey(parsed) {
    if (!parsed) return false;
    if (!parsed.dimId) return false;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y) || !Number.isFinite(parsed.z)) {
      return false;
    }
    return true;
  }

  function canonicalizeStoredKey(rawKey) {
    if (typeof rawKey !== "string") return null;
    const parsed = parseKey(rawKey);
    if (!isValidParsedKey(parsed)) return null;
    return key(parsed.dimId, parsed.x, parsed.y, parsed.z);
  }

  function resetMissingCount(prismKey) {
    if (!prismKey) return;
    missingBlockCounts.delete(prismKey);
  }

  function handleMissingBlock(prismKey, parsed, nowTick) {
    if (!prismKey || !parsed) return;
    const current = missingBlockCounts.get(prismKey) || 0;
    const next = current + 1;
    missingBlockCounts.set(prismKey, next);
    if (current < BLOCK_MISS_THRESHOLD && next >= BLOCK_MISS_THRESHOLD) {
      // Only warn when a player is plausibly near the missing prism.
      // On world load, the registry may contain prisms in unloaded chunks far away;
      // spamming warnings in that case is noisy and not actionable.
      const warnDist = clampInt(cfg.prismRegistryWarnDistance, 0, 256);
      let shouldWarn = warnDist === 0;
      if (!shouldWarn && warnDist > 0) {
        try {
          const players = world?.getAllPlayers?.() || [];
          for (const p of players) {
            const pd = p?.dimension;
            const pl = p?.location;
            if (!pd || !pl) continue;
            if (pd.id !== parsed.dimId) continue;
            const dx = (pl.x - parsed.x);
            const dy = (pl.y - parsed.y);
            const dz = (pl.z - parsed.z);
            if ((dx*dx + dy*dy + dz*dz) <= (warnDist * warnDist)) {
              shouldWarn = true;
              break;
            }
          }
        } catch (e) {
          // if in doubt, still warn
          shouldWarn = true;
        }
      }

      if (shouldWarn) {
        const message = `Prism registry can't read block at ${parsed.dimId} ${parsed.x} ${parsed.y} ${parsed.z} (chunk not loaded). Move closer or keep the area loaded. Registry will retry.`;
        emitRegistryError("PRISM_REGISTRY_BLOCK_UNAVAILABLE", message, nowTick, prismKey);
      }
    }
    addToValidationQueue(prismKey);
  }

  function handleInvalidKey(prismKey, nowTick) {
    if (!prismKey) return;
    removePrism(prismKey);
    resetMissingCount(prismKey);
    emitRegistryError(
      "PRISM_REGISTRY_BAD_KEY",
      `Invalid prism key in registry: ${prismKey}. Removing. This usually means a key format mismatch after a refactor.`,
      nowTick,
      prismKey
    );
  }

  function handleNonPrismBlock(prismKey, nowTick) {
    if (!prismKey) return;
    const parsed = parseKey(prismKey);
    const locationLabel = parsed
      ? `${parsed.dimId} ${parsed.x} ${parsed.y} ${parsed.z}`
      : prismKey;
    const message = `Registered prism no longer exists at ${locationLabel}. Removing from registry.`;
    resetMissingCount(prismKey);
    removePrism(prismKey);
    emitRegistryError("PRISM_REGISTRY_NOT_A_PRISM", message, nowTick, prismKey);
  }

  function addToValidationQueue(prismKey) {
    if (!prismKey || validationQueued.has(prismKey)) return;
    validationQueued.add(prismKey);
    validationQueue.push(prismKey);
  }

  function loadFromStorage() {
    const stored = loadPrismRegistry(world);
    if (Array.isArray(stored) && stored.length > 0) {
      for (const raw of stored) {
        const canonical = canonicalizeStoredKey(raw);
        if (!canonical) continue;
        prisms.add(canonical);
        notePrismRegistryStatus(canonical, true);
        notePrismRegistrySource(canonical, "storage");
      }
      if (prisms.size === 0) {
        seedScanActive = true;
      }
    } else {
      seedScanActive = true;
    }
    for (const k of prisms) addToValidationQueue(k);
  }

  function resolvePrismKeys() {
    return Array.from(prisms);
  }

  function addPrism(prismKey, source = "unknown") {
    if (!prismKey || prisms.has(prismKey)) return false;
    prisms.add(prismKey);
    addToValidationQueue(prismKey);
    markDirty();
    notePrismRegistryStatus(prismKey, true);
    notePrismRegistrySource(prismKey, source);
    return true;
  }

  function removePrism(prismKey) {
    if (!prismKey || !prisms.has(prismKey)) return false;
    prisms.delete(prismKey);
    validationQueued.delete(prismKey);
    markDirty();
    notePrismRegistryStatus(prismKey, false);
    resetMissingCount(prismKey);
    return true;
  }

  function seedScanInit() {
    if (!seedScanActive) return;
    if (seedScanCenters.length > 0) return;

    const players = world?.getAllPlayers?.() || [];
    for (const p of players) {
      const dim = p?.dimension;
      const loc = p?.location;
      if (!dim || !loc) continue;
      seedScanCenters.push({
        dim,
        dimId: dim.id,
        x: Math.floor(loc.x),
        y: Math.floor(loc.y),
        z: Math.floor(loc.z),
      });
    }
  }

  function seedScanTick(budget) {
    if (!seedScanActive) return { scanned: 0, completed: true };
    seedScanInit();

    if (seedScanCenters.length === 0) {
      return { scanned: 0, completed: false };
    }

    const radius = clampInt(cfg.prismSeedScanRadius, 4, 96);
    const size = (radius * 2) + 1;
    const volume = size * size * size;
    let scanned = 0;

    while (scanned < budget && seedScanCenterIndex < seedScanCenters.length) {
      const center = seedScanCenters[seedScanCenterIndex];
      const dim = center?.dim;
      if (!dim) {
        seedScanCenterIndex++;
        seedScanIndex = 0;
        continue;
      }

      if (seedScanIndex >= volume) {
        seedScanCenterIndex++;
        seedScanIndex = 0;
        continue;
      }

      const idx = seedScanIndex++;
      const xOff = (idx % size) - radius;
      const yOff = (Math.floor(idx / size) % size) - radius;
      const zOff = (Math.floor(idx / (size * size)) % size) - radius;

      const x = center.x + xOff;
      const y = center.y + yOff;
      const z = center.z + zOff;

      const block = dim.getBlock({ x, y, z });
      if (block && isPrismBlock(block)) {
        const prismKey = prismKeyFromBlock(block);
        if (addPrism(prismKey, "seedScan")) {
          addToValidationQueue(prismKey);
        }
      }

      scanned++;
    }

    if (seedScanCenterIndex >= seedScanCenters.length) {
      seedScanActive = false;
      return { scanned, completed: true };
    }

    return { scanned, completed: false };
  }

  function validateBudgeted(budget, nowTick = 0) {
    let processed = 0;
    while (processed < budget && validationQueue.length > 0) {
      const prismKey = validationQueue.shift();
      if (!prismKey) continue;
      validationQueued.delete(prismKey);
      processed++;
      const parsed = parseKey(prismKey);
      if (!isValidParsedKey(parsed)) {
        handleInvalidKey(prismKey, nowTick);
        continue;
      }
      const dim = world?.getDimension?.(parsed.dimId);
      if (!dim) {
        handleMissingBlock(prismKey, parsed, nowTick);
        continue;
      }
      const block = dim.getBlock?.({ x: parsed.x, y: parsed.y, z: parsed.z });
      if (!block) {
        handleMissingBlock(prismKey, parsed, nowTick);
        continue;
      }
      if (!isPrismBlock(block)) {
        handleNonPrismBlock(prismKey, nowTick);
        continue;
      }
      resetMissingCount(prismKey);
    }
    if (prisms.size === 0) {
      seedScanActive = true;
    }
    return { processed, remaining: validationQueue.length };
  }

  function markAllForValidation() {
    for (const k of prisms) addToValidationQueue(k);
  }

  function persistIfDirty() {
    if (!dirty) return false;
    savePrismRegistry(world, Array.from(prisms));
    dirty = false;
    return true;
  }

  loadFromStorage();

  return {
    resolvePrismKeys,
    addPrism,
    removePrism,
    validateBudgeted,
    markAllForValidation,
    seedScanTick,
    persistIfDirty,
    isSeedScanActive: () => seedScanActive,
  };
}
