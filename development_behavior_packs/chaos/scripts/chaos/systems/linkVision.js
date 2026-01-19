// scripts/chaos/linkVision.js
import { world, system, MolangVariableMap } from "@minecraft/server";

import { getPairsMap } from "../features/logistics/network/pairs.js";
import { fxPairSuccess } from "../fx/fx.js";
import { FX } from "../fx/fxConfig.js";
import { makeVisionFx } from "../fx/presets.js";
import { getCrystalState } from "../crystallizer.js";
import { isInsightActive, isInsightEnhanced } from "../core/insight/state.js";
import { isPrismId } from "../features/logistics/config.js";
import {
  canonicalizePrismKey,
  key as makePrismKey,
  parseKey as parsePrismKey,
} from "../features/logistics/keys.js";

const WAND_ID = "chaos:wand";
const CRYSTALLIZER_ID = "chaos:crystallizer";
const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:logistics_prism_levels_v1";

const LEVEL_STEP = 100;
const MAX_LEVEL = 5;

// ---------- Perf knobs ----------
const TICK_INTERVAL = 10;              // interval ticks (we budget inside)
const REBUILD_CACHE_EVERY_TICKS = 20;  // refresh flattened link list sometimes
const COUNTS_CACHE_TICKS = 20;
const MAX_LOOK_DISTANCE = 16;
const ACTIONBAR_TICKS = 2;

// ---------- Internal state ----------
let _tick = 0;
let _cacheSig = "";
let _flatLinks = []; // [{ dimId, inPos:{x,y,z}, outPos:{x,y,z} }]
const _rrIndexByPlayer = new Map(); // playerId -> cursor
const _lastActionBarByPlayer = new Map(); // playerId -> tick

// counts cache (shared tick gate)
let _countsTick = -9999;
let _inputCounts = {};
let _outputCounts = {};
let _prismCounts = {};

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

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeCounts(obj) {
  if (!obj || typeof obj !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    const canonical = canonicalizePrismKey(key);
    if (!canonical) continue;
    normalized[canonical] = value;
  }
  return normalized;
}

// ---- Counts cache helpers ----
function countsCacheFresh() {
  return (_tick - _countsTick) <= COUNTS_CACHE_TICKS;
}

function refreshCountsCacheIfNeeded() {
  if (countsCacheFresh()) return;

  _countsTick = _tick;

  // Input
  try {
    const parsed = safeJsonParse(world.getDynamicProperty(DP_INPUT_LEVELS));
    _inputCounts = (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    _inputCounts = {};
  }

  // Output
  try {
    const parsed = safeJsonParse(world.getDynamicProperty(DP_OUTPUT_LEVELS));
    _outputCounts = (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    _outputCounts = {};
  }

  // Prism
  try {
    const parsed = safeJsonParse(world.getDynamicProperty(DP_PRISM_LEVELS));
    _prismCounts = normalizeCounts(parsed);
  } catch {
    _prismCounts = {};
  }
}

function getInputCountsCached() {
  refreshCountsCacheIfNeeded();
  return _inputCounts;
}

function getOutputCountsCached() {
  refreshCountsCacheIfNeeded();
  return _outputCounts;
}

function getPrismCountsCached() {
  refreshCountsCacheIfNeeded();
  return _prismCounts;
}

function getLevelForCount(count) {
  const base = Math.max(1, LEVEL_STEP | 0);
  let needed = base;
  let total = 0;
  const c = Math.max(0, count | 0);
  for (let lvl = 1; lvl <= MAX_LEVEL; lvl++) {
    total += needed;
    if (c < total) return lvl;
    needed *= 2;
  }
  return MAX_LEVEL;
}

function getNextTierDelta(count) {
  const lvl = getLevelForCount(count);
  if (lvl >= MAX_LEVEL) return 0;
  let needed = Math.max(1, LEVEL_STEP | 0);
  let total = 0;
  for (let i = 1; i < (lvl + 1); i++) {
    total += needed;
    needed *= 2;
  }
  return Math.max(0, total - Math.max(0, count | 0));
}

function getTargetBlock(player) {
  try {
    const hit = player.getBlockFromViewDirection({ maxDistance: MAX_LOOK_DISTANCE });
    return hit?.block || null;
  } catch {
    return null;
  }
}

function showWandStats(player) {
  // Gate with lens/goggles visibility - basic debug visibility
  if (!isInsightActive(player)) return;
  const enhanced = isInsightEnhanced(player);
  void enhanced;

  const last = _lastActionBarByPlayer.get(player.id) ?? -9999;
  if ((_tick - last) < ACTIONBAR_TICKS) return;
  _lastActionBarByPlayer.set(player.id, _tick);

  const block = getTargetBlock(player);
  if (!block) return;

  const id = block.typeId;
  const isPrism = !!id && isPrismId(id);
  if (!isPrism && id !== CRYSTALLIZER_ID) return;

  const loc = block.location;
  const k = makePrismKey(block.dimension?.id, loc.x, loc.y, loc.z);
  if (!k) return;

  if (id === CRYSTALLIZER_ID) {
    const state = getCrystalState(k);
    const stored = Math.max(0, Number(state?.fluxStored) || 0);
    const prestige = Math.max(0, Number(state?.prestigeCount) || 0);
    try {
      player.onScreenDisplay.setActionBar(
        `Chaos Crystallizer | Stored: ${stored} | Prestige: ${prestige}`
      );
    } catch {}
    return;
  }

  // Unified system - prisms use prism counts DP
  const counts = getPrismCountsCached();
  const count = (counts && counts[k] != null) ? Number(counts[k]) : null;

  const level = Number.isFinite(count) ? getLevelForCount(count) : 1;
  const countLabel = Number.isFinite(count) ? `${count}` : "n/a";
  const nextLabel = Number.isFinite(count)
    ? (getNextTierDelta(count) > 0 ? `${getNextTierDelta(count)}` : "max")
    : "n/a";

  try {
    player.onScreenDisplay.setActionBar(
      `Chaos Prism | L${level} | Transfers: ${countLabel} | Next: ${nextLabel}`
    );
  } catch {}
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

      const inParsed = parsePrismKey(inKey);
      if (!inParsed) continue;

      const inPos = { x: inParsed.x, y: inParsed.y, z: inParsed.z };

      for (const outKey of outSet) {
        const outParsed = parsePrismKey(outKey);
        if (!outParsed) continue;

        if (outParsed.dimId !== inParsed.dimId) continue;

        next.push({
          dimId: inParsed.dimId,
          inPos,
          outPos: { x: outParsed.x, y: outParsed.y, z: outParsed.z },
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
        if (!isInsightActive(player)) continue;

        const loc = { x: player.location.x, y: player.location.y + 1.2, z: player.location.z };
        const molang = new MolangVariableMap();
        molang.setFloat("variable.chaos_color_r", 0.2);
        molang.setFloat("variable.chaos_color_g", 0.8);
        molang.setFloat("variable.chaos_color_b", 1.0);
        molang.setFloat("variable.chaos_color_a", 1.0);
        molang.setSpeedAndDirection("variable.chaos_move", 2.0, { x: 1, y: 0, z: 0 });
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
            player.dimension.spawnParticle(
              s.id,
              { x: loc.x + s.off.x, y: loc.y + s.off.y, z: loc.z + s.off.z },
              molang
            );
          } catch {}
        }
      }
    }

    const maxDist = Number(FX.linkVisionDistance) || 32;
    const maxDistSq = maxDist * maxDist;
    const perTick = Math.max(1, Number(FX.linksPerTickBudget) || 24);

    for (const player of world.getAllPlayers()) {
      if (!isHoldingWand(player)) continue;
      if (!isInsightActive(player)) continue;

      showWandStats(player);

      if (_flatLinks.length === 0) continue;

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


