// scripts/chaos/cleanupOnBreak.js
import { world } from "@minecraft/server";

import { getPairsMap, savePairsToWorldSafe, isPersistenceEnabled } from "../features/links/pairs.js";
import { fxPairSuccess } from "../fx/fx.js";
import {
  SFX_UNPAIR,
  PARTICLE_UNPAIR_SUCCESS,
  PARTICLE_UNPAIR_BEAM,
  //PARTICLE_UNPAIR_EXTRA, // if you don't have this export, remove it + the line that uses it
} from "../core/constants.js";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

// cap visuals so breaking a hub with 200 outputs doesn't nuke FPS
const MAX_UNPAIR_FX_BEAMS = 12;

function makeKeyFromParts(dimId, loc) {
  // matches your persisted format: "dimId|x,y,z"
  return `${dimId}|${loc.x},${loc.y},${loc.z}`;
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

function makeUnpairFx() {
  // Uses your fxPairSuccess "unpair mode" switch
  const fx = {
    _unpair: true,
    sfxPair: null,
    sfxUnpair: SFX_UNPAIR,

    particleSuccess: null,
    particleUnpair: PARTICLE_UNPAIR_SUCCESS,

    particleBeam: null,
    particleBeamUnpair: PARTICLE_UNPAIR_BEAM,

    // Optional extra burst if you have it defined
    //particleUnpairExtra: PARTICLE_UNPAIR_EXTRA ?? null,
  };
  return fx;
}

function pruneAndCollectFx(deadKey) {
  const pairs = getPairsMap();
  let changed = false;

  // We'll collect a few beam endpoints to visualize the unlinking.
  // Each entry: { fromPos, toPos }
  const fxBeams = [];

  // If it was an input, remove the whole entry and collect its outputs for FX
  const outSet = pairs.get(deadKey);
  if (outSet && outSet.size) {
    const inParsed = parseKey(deadKey);
    if (inParsed) {
      for (const outKey of outSet) {
        if (fxBeams.length >= MAX_UNPAIR_FX_BEAMS) break;
        const outParsed = parseKey(outKey);
        if (!outParsed) continue;
        if (outParsed.dimId !== inParsed.dimId) continue;
        fxBeams.push({ fromPos: inParsed.pos, toPos: outParsed.pos });
      }
    }

    pairs.delete(deadKey);
    changed = true;
  }

  // If it was an output anywhere, remove it from all sets
  for (const [inKey, set] of pairs) {
    if (!set || set.size === 0) continue;

    if (set.has(deadKey)) {
      // FX: show unlink beam from input -> dead output
      if (fxBeams.length < MAX_UNPAIR_FX_BEAMS) {
        const inParsed = parseKey(inKey);
        const deadParsed = parseKey(deadKey);
        if (inParsed && deadParsed && inParsed.dimId === deadParsed.dimId) {
          fxBeams.push({ fromPos: inParsed.pos, toPos: deadParsed.pos });
        }
      }

      set.delete(deadKey);
      changed = true;

      if (set.size === 0) pairs.delete(inKey);
    }
  }

  return { changed, fxBeams };
}

function handleBrokenNode(player, dimId, loc) {
  try {
    const deadKey = makeKeyFromParts(dimId, loc);

    const { changed, fxBeams } = pruneAndCollectFx(deadKey);

    if (!changed) return;

    // Persist best-effort (only if DP is still healthy)
    if (isPersistenceEnabled()) {
      savePairsToWorldSafe();
    }

    // Play unpair animation beams (visual reinforcement)
    // Best effort: if player is missing, just skip FX silently.
    if (!player) return;

    const fx = makeUnpairFx();
    for (const beam of fxBeams) {
      fxPairSuccess(player, beam.fromPos, beam.toPos, fx);
    }
  } catch {
    // silent failure by design
  }
}

export function startCleanupOnBreak() {
  // ✅ Reliable source of "what block was broken" is brokenBlockPermutation
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const player = ev.player;
      const block = ev.block; // location + dimension are still useful

      if (!block) return;

      const brokenId = ev.brokenBlockPermutation?.type?.id;
      if (brokenId !== INPUT_ID && brokenId !== OUTPUT_ID) return;

      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;

      handleBrokenNode(player, dimId, loc);
    } catch {
      // ignore
    }
  });

  // Optional explosions etc. left out here on purpose:
  // those events vary by version and aren’t critical for your milestone.
}
