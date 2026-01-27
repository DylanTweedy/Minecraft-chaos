// scripts/chaos/features/logistics/phases/08_movement/movementSim.js
import { OrbStates, OrbModes } from "../../state/enums.js";
import { MolangVariableMap } from "@minecraft/server";
import { parseKey } from "../../keys.js";
import { getPrismTier } from "../../config.js";
import { dropOrbOnBrokenEdge } from "./beamBreakDrops.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { queueFxParticle } from "../../../../fx/fx.js";
import { emitTrace } from "../../../../core/insight/trace.js";

function resolveOrbParticle(FX, itemTypeId, mode) {
  if (!FX) return null;
  if (itemTypeId && FX.particleExoticOrbById && FX.particleExoticOrbById[itemTypeId]) {
    return FX.particleExoticOrbById[itemTypeId];
  }
  if (itemTypeId && FX.particleFluxOrbByTier && Array.isArray(FX.particleFluxOrbByTier)) {
    let fluxTier = 0;
    if (itemTypeId === "chaos:flux_1") fluxTier = 1;
    else if (itemTypeId === "chaos:flux_2") fluxTier = 2;
    else if (itemTypeId === "chaos:flux_3") fluxTier = 3;
    else if (itemTypeId === "chaos:flux_4") fluxTier = 4;
    else if (itemTypeId === "chaos:flux_5") fluxTier = 5;
    if (fluxTier > 0) return FX.particleFluxOrbByTier[fluxTier - 1] || null;
  }
  if (FX.particleTransferItemByMode && mode) {
    const byMode = FX.particleTransferItemByMode;
    if (mode === OrbModes.ATTUNED && byMode.attuned) return byMode.attuned;
    if (mode === OrbModes.DRIFT && byMode.drift) return byMode.drift;
    if (mode === OrbModes.WALKING && byMode.walking) return byMode.walking;
  }
  return FX.particleTransferItem || null;
}

function getTierColor(tier) {
  const lvl = Math.max(1, Math.min(5, tier | 0));
  const palette = [
    { r: 0.2, g: 0.55, b: 1.0, a: 1.0 },   // L1 blue
    { r: 0.2, g: 0.9, b: 0.35, a: 1.0 },   // L2 green
    { r: 1.0, g: 0.9, b: 0.2, a: 1.0 },    // L3 yellow
    { r: 1.0, g: 0.2, b: 0.2, a: 1.0 },    // L4 red
    { r: 0.75, g: 0.4, b: 0.95, a: 1.0 },  // L5 purple
  ];
  return palette[lvl - 1] || palette[0];
}

function buildOrbMolang(dir, speedBlocksPerTick, lifetimeSeconds, tier, lensBoost = 0) {
  try {
    if (!dir) return null;
    const m = new MolangVariableMap();
    const speedPerSec = Math.max(0.6, Math.min(12.0, Number(speedBlocksPerTick) * 20));
    m.setSpeedAndDirection("variable.chaos_move", speedPerSec, dir);
    m.setFloat("variable.chaos_move.speed", speedPerSec);
    m.setFloat("variable.chaos_move.direction_x", dir.x);
    m.setFloat("variable.chaos_move.direction_y", dir.y);
    m.setFloat("variable.chaos_move.direction_z", dir.z);
    const life = Math.max(0.12, Math.min(5.0, Number(lifetimeSeconds) || 0.35));
    m.setFloat("variable.chaos_lifetime", life);
    const c = getTierColor(tier);
    const boost = Math.max(0, Math.min(1, Number(lensBoost) || 0));
    const r = c.r + (1 - c.r) * boost;
    const g = c.g + (1 - c.g) * boost;
    const b = c.b + (1 - c.b) * boost;
    m.setFloat("variable.chaos_color_r", r);
    m.setFloat("variable.chaos_color_g", g);
    m.setFloat("variable.chaos_color_b", b);
    m.setFloat("variable.chaos_color_a", c.a);
    return m;
  } catch {
    return null;
  }
}

function resolvePrismBlock(ctx, prismKey) {
  const info = ctx.services?.resolveBlockInfo?.(prismKey);
  if (info?.block) return info.block;
  const parsed = parseKey(prismKey);
  if (!parsed) return null;
  const dim = ctx.services?.cacheManager?.getDimensionCached
    ? ctx.services.cacheManager.getDimensionCached(parsed.dimId)
    : ctx.world?.getDimension?.(parsed.dimId);
  if (!dim) return null;
  return dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
}

export function advanceMovement(ctx) {
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const FX = ctx.FX;
  const maxOrbFx = Math.max(0, Number(ctx.cfg?.maxOrbFxPerTick) || 0);
  let orbFxUsed = 0;
  const orbs = ctx.state?.orbs || [];
  if (!linkGraph) return;
  let moved = 0;
  const maxMoves = ctx.budgets.state.movements | 0;
  const nowTick = ctx.nowTick | 0;
  // Spawn one orb particle per edge hop (lifetime set by speed + distance).

  for (const orb of orbs) {
    if (moved >= maxMoves) break;
    if (!orb || orb.state !== OrbStates.IN_FLIGHT) continue;

    const edge = linkGraph?.getEdgeBetweenKeys(orb.edgeFromKey, orb.edgeToKey);
    if (!edge) {
      dropOrbOnBrokenEdge(ctx, orb, edge, "beam_break");
      orb.state = null;
      orb._remove = true;
      moved++;
      continue;
    }
    orb.edgeMeta = edge.meta || orb.edgeMeta || null;

    if (!(orb.edgeEpoch | 0)) {
      orb.edgeEpoch = edge.epoch | 0;
    }

    if ((edge.epoch | 0) !== (orb.edgeEpoch | 0)) {
      dropOrbOnBrokenEdge(ctx, orb, edge, "beam_break");
      orb.state = null;
      orb._remove = true;
      moved++;
      continue;
    }

    const speed = Math.max(0.01, Number(orb.speed) || 1);
    const lensCount = Math.max(0, edge?.meta?.lensCount | 0);
    const lensSpeedBoost = Math.max(0, Number(ctx.cfg?.lensSpeedBoostPerLens) || 0);
    const lensSpeedMax = Math.max(1, Number(ctx.cfg?.lensSpeedBoostMax) || 2);
    const lensScaleRaw = 1 + (lensCount * lensSpeedBoost);
    const lensScale = Math.min(lensSpeedMax, Math.max(1, lensScaleRaw));
    const effectiveSpeed = speed * lensScale;
    const edgeLen = Math.max(1, (orb.edgeLength | 0) || (edge.length | 0));
    orb.progress += effectiveSpeed;
    orb.edgeSpeed = effectiveSpeed;

    const edgeKey = `${orb.edgeFromKey}|${orb.edgeToKey}|${orb.edgeEpoch | 0}`;
    if (orb._fxEdgeKey !== edgeKey) {
      orb._fxEdgeKey = null;
      orb._fxSpawned = false;
    }
    if (maxOrbFx > 0 && orbFxUsed < maxOrbFx && !orb._fxSpawned) {
      const from = parseKey(orb.edgeFromKey);
      const to = parseKey(orb.edgeToKey);
      if (from && to && from.dimId === to.dimId) {
        let dim = cacheManager?.getDimensionCached
          ? cacheManager.getDimensionCached(from.dimId)
          : null;
        if (!dim) dim = ctx.world?.getDimension?.(from.dimId);
        const particleId = resolveOrbParticle(FX, orb.itemTypeId, orb.mode);
        if (dim && particleId) {
          const t = Math.max(0, Math.min(1, (orb.progress || 0) / edgeLen));
          const px = from.x + (to.x - from.x) * t + 0.5;
          const py = from.y + (to.y - from.y) * t + 0.5;
          const pz = from.z + (to.z - from.z) * t + 0.5;
          const dir = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
          const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
          const ndir = len > 0.0001 ? { x: dir.x / len, y: dir.y / len, z: dir.z / len } : { x: 0, y: 0, z: 0 };
          const remaining = Math.max(0.01, edgeLen - (orb.progress || 0));
          const speedPerSec = Math.max(0.6, Math.min(12.0, Number(effectiveSpeed) * 20));
          const lifetime = Math.max(0.1, Math.min(5.0, remaining / speedPerSec));
          const colorSourceKey = orb.sourcePrismKey || orb.edgeFromKey;
          const fromBlock = resolvePrismBlock(ctx, colorSourceKey);
          const tier = fromBlock ? getPrismTier(fromBlock) : 1;
          const lensFxBoost = Math.max(0, Number(ctx.cfg?.lensFxBoostPerLens) || 0);
          const lensFxMax = Math.max(0, Number(ctx.cfg?.lensFxBoostMax) || 0.6);
          const lensFx = Math.min(lensFxMax, lensCount * lensFxBoost);
          const molang = buildOrbMolang(ndir, effectiveSpeed, lifetime, tier, lensFx);
          queueFxParticle(dim, particleId, { x: px, y: py, z: pz }, molang);
          orb._fxEdgeKey = edgeKey;
          orb._fxSpawned = true;
          orbFxUsed++;
        }
      }
    }

    if (orb.progress >= edgeLen) {
      orb.state = OrbStates.AT_PRISM;
      orb.currentPrismKey = orb.edgeToKey;
      orb.progress = 0;
      orb._fxEdgeKey = null;
      orb._fxSpawned = false;
      if (Array.isArray(orb.path) && (orb.pathIndex | 0) >= 0) {
        const nextIdx = (orb.pathIndex | 0) + 1;
        if (orb.path[nextIdx] === orb.edgeToKey) {
          orb.pathIndex = nextIdx;
        }
      }
      ctx.arrivalQueue.push({ orbId: orb.id, prismKey: orb.edgeToKey });
      bumpCounter(ctx, "arrivals_movement");
      if (ctx.cfg?.debugEdgeLenTrace && typeof emitTrace === "function") {
        const ticksInFlight = (ctx.nowTick | 0) - (orb.createdAtTick | 0);
        emitTrace(null, "transfer", {
          text: `[Transfer] Arrive orb=${orb.id} edgeLen=${edgeLen} speed=${speed.toFixed(3)} ticks=${ticksInFlight}`,
          category: "transfer",
          dedupeKey: `transfer_arrive_${orb.id}_${ctx.nowTick | 0}`,
        });
      }
    }

    moved++;
  }

  if (orbs.length > 0) {
    for (let i = orbs.length - 1; i >= 0; i--) {
      if (orbs[i]?._remove) {
        ctx.state.orbsById?.delete(orbs[i].id);
        orbs.splice(i, 1);
      }
    }
  }
}






