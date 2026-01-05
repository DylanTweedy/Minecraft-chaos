// scripts/chaos/linkVision.js
import { world, system, MolangVariableMap } from "@minecraft/server";

import { getPairsMap } from "../features/links/pairs.js";
import { fxPairSuccess } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeVisionFx } from "../fx/presets.js";

const WAND_ID = "chaos:wand";

// ---------- Perf knobs ----------
const TICK_INTERVAL = 10;              // interval ticks (we budget inside)
const REBUILD_CACHE_EVERY_TICKS = 20; // refresh flattened link list sometimes

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
  const visionFx = makeVisionFx();

  system.runInterval(() => {
    _tick++;

    rebuildFlatLinks();
    if (FX.debugSpawnBeamParticles && (_tick % 20) === 0) {
      for (const player of world.getAllPlayers()) {
        if (!isHoldingWand(player)) continue;
        const loc = { x: player.location.x, y: player.location.y + 1.2, z: player.location.z };
        const molang = new MolangVariableMap();
        molang.setFloat("variable.chaos_color_r", 0.2);
        molang.setFloat("variable.chaos_color_g", 0.8);
        molang.setFloat("variable.chaos_color_b", 1.0);
        molang.setFloat("variable.chaos_color_a", 1.0);
        molang.setSpeedAndDirection("variable.chaos_move", 2.0, { x: 1, y: 0, z: 0 });
        // Also set explicit scalar/vector fields in case speed/direction aren't exposed via setSpeedAndDirection.
        molang.setFloat("variable.chaos_move.speed", 2.0);
        molang.setFloat("variable.chaos_move.direction_x", 1.0);
        molang.setFloat("variable.chaos_move.direction_y", 0.0);
        molang.setFloat("variable.chaos_move.direction_z", 0.0);
        molang.setFloat("variable.chaos_dist", 4.0);
        molang.setFloat("variable.chaos_speed", 2.0);
        molang.setFloat("variable.chaos_lifetime", 2.0);
        molang.setFloat("variable.chaos_dir_x", 1.0);
        molang.setFloat("variable.chaos_dir_y", 0.0);
        molang.setFloat("variable.chaos_dir_z", 0.0);
        const samples = [
          { id: FX.particleBeamCore, off: { x: 0.0, y: 0.0, z: 0.0 } },
          { id: FX.particleBeamHaze, off: { x: 0.4, y: 0.0, z: 0.0 } },
          { id: FX.particleBeamSpiral, off: { x: -0.4, y: 0.0, z: 0.0 } },
          { id: FX.particleBeamInputCharge, off: { x: 0.0, y: 0.0, z: 0.4 } },
          { id: FX.particleBeamOutputBurst, off: { x: 0.0, y: 0.0, z: -0.4 } },
        ];
        for (const s of samples) {
          if (!s.id) continue;
          try {
            player.dimension.spawnParticle(s.id, {
              x: loc.x + s.off.x,
              y: loc.y + s.off.y,
              z: loc.z + s.off.z,
            }, molang);
          } catch {}
        }
      }
    }
    if (_flatLinks.length === 0) return;

    const maxDist = Number(FX.linkVisionDistance) || 32;
    const maxDistSq = maxDist * maxDist;
    const perTick = Math.max(1, Number(FX.linksPerTickBudget) || 24);

    for (const player of world.getAllPlayers()) {
      if (!isHoldingWand(player)) continue;

      const dimId = player.dimension.id;
      const pLoc = player.location;

      let cursor = _rrIndexByPlayer.get(player.id) ?? 0;
      let beams = 0;

      const maxAttempts = Math.min(_flatLinks.length, perTick * 8);
      let attempts = 0;

      while (beams < perTick && attempts < maxAttempts) {
        attempts++;

        if (cursor >= _flatLinks.length) cursor = 0;
        const link = _flatLinks[cursor++];
        if (!link) continue;

        if (link.dimId !== dimId) continue;

        const near =
          distSq(pLoc, link.inPos) <= maxDistSq ||
          distSq(pLoc, link.outPos) <= maxDistSq;

        if (!near) continue;

        fxPairSuccess(player, link.inPos, link.outPos, visionFx);
        beams++;
      }

      _rrIndexByPlayer.set(player.id, cursor);

    }
  }, TICK_INTERVAL);
}
