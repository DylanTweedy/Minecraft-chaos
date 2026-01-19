// scripts/chaos/vision/linkVisionExposed.js
// Exposed Link Vision API for Insight Lens/Goggles

import { getPairsMap } from "../features/logistics/network/pairs.js";
import { fxPairSuccess } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeVisionFx } from "../fx/presets.js";

// Cache for flat links (shared with linkVision.js logic)
let _flatLinksCache = [];
let _cacheSig = "";
let _lastRebuildTick = -9999;

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function parseKey(key) {
  try {
    const bar = key.indexOf("|");
    if (bar === -1) return null;
    const dimId = key.slice(0, bar);
    const rest = key.slice(bar + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { dimId, pos: { x, y, z } };
  } catch {
    return null;
  }
}

function computeSignature(pairsMap) {
  let inputs = 0;
  let outputs = 0;
  for (const [, outSet] of pairsMap) {
    inputs++;
    outputs += outSet?.size ?? 0;
  }
  return `${inputs}:${outputs}`;
}

function rebuildFlatLinks(nowTick) {
  // Rebuild cache if needed (every 20 ticks or on signature change)
  const pairsMap = getPairsMap();
  const sig = computeSignature(pairsMap);
  
  if (sig === _cacheSig && (nowTick - _lastRebuildTick) < 20) {
    return _flatLinksCache;
  }
  
  const next = [];
  for (const [inKey, outSet] of pairsMap) {
    if (!outSet || outSet.size === 0) continue;
    const inParsed = parseKey(inKey);
    if (!inParsed) continue;
    
    for (const outKey of outSet) {
      const outParsed = parseKey(outKey);
      if (!outParsed) continue;
      if (outParsed.dimId !== inParsed.dimId) continue;
      
      next.push({
        dimId: inParsed.dimId,
        inPos: inParsed.pos,
        outPos: outParsed.pos,
      });
    }
  }
  
  _flatLinksCache = next;
  _cacheSig = sig;
  _lastRebuildTick = nowTick;
  return _flatLinksCache;
}

/**
 * Render link vision for a player (for Insight Lens/Goggles)
 * @param {Player} player - The player to render for
 * @param {number} nowTick - Current tick
 * @param {number} maxDistance - Maximum distance to render links
 * @param {number} budget - Maximum links to render this tick
 * @returns {number} Number of links rendered
 */
export function renderLinkVisionForPlayer(player, nowTick, maxDistance = 32, budget = 24) {
  if (!player || !player.dimension) return 0;
  
  const visionFx = makeVisionFx();
  const flatLinks = rebuildFlatLinks(nowTick);
  if (flatLinks.length === 0) return 0;
  
  const maxDistSq = maxDistance * maxDistance;
  const dimId = player.dimension.id;
  const pLoc = player.location;
  
  let rendered = 0;
  const maxAttempts = Math.min(flatLinks.length, budget * 8);
  let attempts = 0;
  
  for (const link of flatLinks) {
    if (rendered >= budget || attempts >= maxAttempts) break;
    attempts++;
    
    if (link.dimId !== dimId) continue;
    
    const near =
      distSq(pLoc, link.inPos) <= maxDistSq ||
      distSq(pLoc, link.outPos) <= maxDistSq;
    
    if (!near) continue;
    
    try {
      fxPairSuccess(player, link.inPos, link.outPos, visionFx);
      rendered++;
    } catch {
      // ignore
    }
  }
  
  return rendered;
}

