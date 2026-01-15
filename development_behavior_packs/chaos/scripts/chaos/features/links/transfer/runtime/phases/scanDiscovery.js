// scripts/chaos/features/links/transfer/runtime/phases/scanDiscovery.js

import { ok, phaseStep } from "../helpers/result.js";
import {
  emitInsightError,
  hasAnyRegisteredPrism,
  isPrismRegistered,
  getFirstRegisteredPrismKey,
  getPrismRegistrySource,
} from "../../../../../core/insight/trace.js";
import { makePrismKey, parsePrismKey } from "../../keys.js";

const NEIGHBOR_DELTAS = [
  { dx: 1, dy: 0, dz: 0 },
  { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy: 1, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 0, dz: 1 },
  { dx: 0, dy: 0, dz: -1 },
];

function findNearbyRegisteredKeys(coords) {
  if (!coords) return [];
  const neighbors = [];
  for (const delta of NEIGHBOR_DELTAS) {
    const candidate = makePrismKey(
      coords.dimId,
      coords.x + delta.dx,
      coords.y + delta.dy,
      coords.z + delta.dz
    );
    if (candidate && isPrismRegistered(candidate)) {
      neighbors.push(candidate);
    }
  }
  return neighbors;
}

export function createScanDiscoveryPhase(deps) {
  return {
    name: "scanDiscovery",
    run(ctx) {
      const prismCount = Array.isArray(ctx?.prismKeys) ? ctx.prismKeys.length : 0;
      const nowTick = typeof ctx?.nowTick === "number" ? ctx.nowTick : 0;
      phaseStep(ctx, `scanDiscovery: ${prismCount} prisms`);

      if (hasAnyRegisteredPrism() && Array.isArray(ctx?.prismKeys)) {
        for (const observedKey of ctx.prismKeys) {
          if (!observedKey || isPrismRegistered(observedKey)) continue;
        const coords = parsePrismKey(observedKey);
        const locationLabel = coords
          ? `${coords.dimId} ${coords.x} ${coords.y} ${coords.z}`
          : observedKey;
        const sample = getFirstRegisteredPrismKey() || "none";
        const nearbyKeys = coords ? findNearbyRegisteredKeys(coords) : [];
        const nearbyText = nearbyKeys.length
          ? `Nearby registry keys: ${nearbyKeys.join(", ")}.`
          : "No nearby registry keys detected.";
        const sampleKey = sample !== "none" ? sample : null;
        const sourceKey = nearbyKeys.length ? nearbyKeys[0] : sampleKey;
        const sourceHint = sourceKey ? getPrismRegistrySource(sourceKey) : null;
        const sourceText = sourceHint
          ? `Last registry registration source: ${sourceHint}.`
          : "";
        const suggestionText =
          "Registry likely recorded an offset position (e.g., y+1). Check prism registration call sites for above()/below()/offset() calls or beam endpoint locations.";
        const message = `Prism key mismatch: observed prism at ${locationLabel} (${observedKey}) is not found in registry (${sample}). ${nearbyText} ${sourceText} ${suggestionText}`;
        emitInsightError("PRISM_KEY_MISMATCH", message, nowTick, observedKey);
        break;
      }
      }

      return ok();
    },
  };
}
