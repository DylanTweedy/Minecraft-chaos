// scripts/chaos/linkVision.js
import { world, system } from "@minecraft/server";

import { getPairsMap } from "../features/links/pairs.js";
import { fxPairSuccess } from "../fx/fx.js";
import { makeVisionFx } from "../fx/presets.js";

const WAND_ID = "chaos:wand";

// ---------- Perf knobs ----------
const TICK_INTERVAL = 2;              // interval ticks (we budget inside)
const REBUILD_CACHE_EVERY_TICKS = 20; // refresh flattened link list sometimes
const MAX_DISTANCE = 48;              // show links near player
const BEAMS_PER_PLAYER_PER_TICK = 1;  // budget per wand-holder per tick

// ---------- Internal state ----------
let _tick = 0;
let _cacheSig = "";
let _flatLinks = []; // [{ dimId, inPos:{x,y,z}, outPos:{x,y,z} }]
const _rrIndexByPlayer = new Map(); // playerId -> cursor

function isHoldingWand(player) {
  try {
    const inv = player.getComponent("minecraft:inventory");
    const c = inv?.container;
    if (!c) return false;
    const item = c.getItem(player.selectedSlotIndex);
    return item?.typeId === WAND_ID;
  } catch {
    return false;
  }
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function parseKey(key) {
  // Expected: "dimId|x,y,z"
  // Keep this tiny & robust; if parsing fails, return null.
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
  // cheap change detector
  let inputs = 0;
  let outputs = 0;
  for (const [, outSet] of pairsMap) {
    inputs++;
    outputs += outSet?.size ?? 0;
  }
  return `${inputs}:${outputs}`;
}

function rebuildFlatLinks() {
  const pairsMap = getPairsMap(); // inputKey -> Set(outputKey)
  const sig = computeSignature(pairsMap);

  if (sig === _cacheSig && (_tick % REBUILD_CACHE_EVERY_TICKS) !== 0) return;

  const next = [];

  for (const [inKey, outSet] of pairsMap) {
    if (!outSet || outSet.size === 0) continue;

    const inParsed = parseKey(inKey);
    if (!inParsed) continue;

    for (const outKey of outSet) {
      const outParsed = parseKey(outKey);
      if (!outParsed) continue;

      // Vision matches your “same-dimension enforcement”
      if (outParsed.dimId !== inParsed.dimId) continue;

      next.push({
        dimId: inParsed.dimId,
        inPos: inParsed.pos,
        outPos: outParsed.pos,
      });
    }
  }

  _flatLinks = next;
  _cacheSig = sig;

  // keep cursors in range
  for (const [pid, idx] of _rrIndexByPlayer) {
    if (idx >= _flatLinks.length) _rrIndexByPlayer.set(pid, 0);
  }
}

export function startLinkVision() {
  // Silent FX config:
  // - no sound
  // - no endpoint "success" particles
  // - beam particle only
  const visionFx = makeVisionFx();

  system.runInterval(() => {
    _tick++;

    rebuildFlatLinks();
    if (_flatLinks.length === 0) return;

    const maxDistSq = MAX_DISTANCE * MAX_DISTANCE;

    for (const player of world.getAllPlayers()) {
      if (!isHoldingWand(player)) continue;

      const dimId = player.dimension.id;
      const pLoc = player.location;

      let cursor = _rrIndexByPlayer.get(player.id) ?? 0;

      let beams = 0;

      // bounded attempts so we never spin forever skipping far links
      const maxAttempts = Math.min(_flatLinks.length, BEAMS_PER_PLAYER_PER_TICK * 8);
      let attempts = 0;

      while (beams < BEAMS_PER_PLAYER_PER_TICK && attempts < maxAttempts) {
        attempts++;

        if (cursor >= _flatLinks.length) cursor = 0;
        const link = _flatLinks[cursor++];
        if (!link) continue;

        if (link.dimId !== dimId) continue;

        // Near either endpoint (local “reveal network” feel)
        const near =
          distSq(pLoc, link.inPos) <= maxDistSq ||
          distSq(pLoc, link.outPos) <= maxDistSq;

        if (!near) continue;

        // ✅ Uses fx.js internal drawBeam WITHOUT importing it
        fxPairSuccess(player, link.inPos, link.outPos, visionFx);
        beams++;
      }

      _rrIndexByPlayer.set(player.id, cursor);
    }
  }, TICK_INTERVAL);
}
