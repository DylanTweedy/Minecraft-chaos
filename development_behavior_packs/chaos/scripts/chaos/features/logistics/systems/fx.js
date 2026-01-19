// scripts/chaos/features/logistics/systems/fx.js
import { MolangVariableMap, system } from "@minecraft/server";
import { isPrismBlock, getPrismTier } from "../config.js";
import { buildFluxFxSegments } from "../routing/path.js";
import { queueFxParticle } from "../../../fx/fx.js";
import { getFluxTier, isFluxTypeId } from "../../../flux.js";

export function createFxManager(cfg, deps) {
  if (!cfg || !deps) return null; // Return null if required params are missing
  const FX = deps.FX;
  const debugEnabled = deps.debugEnabled || false;
  const debugState = deps.debugState || null;
  const getDimensionCached = deps.getDimensionCached;
  const getOrbStepTicks = deps.getOrbStepTicks || (() => 60); // Fallback if not provided
  const orbFxBudgetUsed = deps.orbFxBudgetUsed || { value: 0 }; // Reference object { value: number } to controller's orbFxBudgetUsed
  const fluxFxInflight = deps.fluxFxInflight || []; // Reference to controller's fluxFxInflight array

  // Orb particles are purely visual, but it's easy to accidentally spawn duplicates
  // (e.g. hybrid + regular inflight, or double-processing during refactors).
  // Dedupe within a tiny tick window to prevent "double orbs" and flicker.
  const recentOrbSpawns = new Map(); // key -> lastTick
  const ORB_DEDUPE_WINDOW_TICKS = 2;

  function normalizeDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(len) || len <= 0.0001) return null;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  function getOrbColor(level) {
    const lvl = Math.min(cfg.maxLevel | 0, Math.max(1, level | 0));
    const palette = [
      { r: 0.78, g: 0.8, b: 0.84, a: 1.0 }, // L1 iron
      { r: 1.0, g: 0.78, b: 0.2, a: 1.0 },  // L2 gold
      { r: 0.2, g: 0.9, b: 0.9, a: 1.0 },   // L3 diamond
      { r: 0.2, g: 0.2, b: 0.24, a: 1.0 },  // L4 netherite
      { r: 0.85, g: 0.65, b: 1.0, a: 1.0 }, // L5 masterwork
    ];
    return palette[lvl - 1] || palette[0];
  }

  function spawnLevelUpBurst(block) {
    try {
      if (!block) return;
      const dim = block.dimension;
      const particleId = FX?.particleSuccess || FX?.particleBeamOutputBurst;
      if (!dim || !particleId) return;

      const count = Math.max(1, cfg.levelUpBurstCount | 0);
      const radius = Math.max(0, Number(cfg.levelUpBurstRadius) || 0.35);
      const base = block.location;
      for (let i = 0; i < count; i++) {
        const ox = (Math.random() * 2 - 1) * radius;
        const oy = (Math.random() * 2 - 1) * radius;
        const oz = (Math.random() * 2 - 1) * radius;
        queueFxParticle(dim, particleId, {
          x: base.x + 0.5 + ox,
          y: base.y + 0.6 + oy,
          z: base.z + 0.5 + oz,
        });
      }
    } catch (e) {
      // ignore
    }
  }

  function spawnOrbStep(dim, from, to, level, fromBlock, toBlock, itemTypeId, lengthSteps, logicalTicks, speedScale = 1.0) {
    try {
      if (!FX || !FX.particleTransferItem) return false;
      let fxId = FX.particleTransferItem;
      if (itemTypeId && FX?.particleExoticOrbById && FX.particleExoticOrbById[itemTypeId]) {
        fxId = FX.particleExoticOrbById[itemTypeId] || fxId;
      } else if (itemTypeId && FX?.particleFluxOrbByTier && Array.isArray(FX.particleFluxOrbByTier)) {
        const tier = getFluxTier(itemTypeId);
        if (tier > 0) {
          const idx = tier - 1;
          fxId = FX.particleFluxOrbByTier[idx] || fxId;
        }
      }
      const maxOrbFx = Math.max(0, cfg.maxOrbFxPerTick | 0);
      if (maxOrbFx > 0 && orbFxBudgetUsed && typeof orbFxBudgetUsed.value === 'number' && orbFxBudgetUsed.value >= maxOrbFx) {
        if (debugEnabled && debugState) debugState.orbFxSkipped++;
        return false; // Return false when budget exceeded, not true
      }
      if (maxOrbFx > 0 && orbFxBudgetUsed && typeof orbFxBudgetUsed.value === 'number') {
        orbFxBudgetUsed.value++;
      }
      const dir = normalizeDir(from, to);
      if (!dir) return false;

      // Per-tick dedupe: same segment + same item type in same dimension.
      // We keep the key short to avoid GC churn.
      const nowTick = typeof system?.currentTick === "number" ? system.currentTick : 0;
      const dedupeKey = `${dim?.id || ""}|${from.x},${from.y},${from.z}>${to.x},${to.y},${to.z}|${itemTypeId || ""}`;
      const lastTick = recentOrbSpawns.get(dedupeKey);
      if (typeof lastTick === "number" && nowTick - lastTick <= ORB_DEDUPE_WINDOW_TICKS) {
        return false;
      }
      recentOrbSpawns.set(dedupeKey, nowTick);
      if (recentOrbSpawns.size > 2048) {
        // prune old keys lazily
        for (const [k, t] of recentOrbSpawns) {
          if (nowTick - (t | 0) > ORB_DEDUPE_WINDOW_TICKS * 4) recentOrbSpawns.delete(k);
        }
      }

      const molang = new MolangVariableMap();
      
      // Calculate distance for this segment
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      
      // Calculate visual lifetime from logical time to keep them in sync
      // logicalTicks is the time in ticks, convert to seconds (20 ticks = 1 second)
      // Avoid ultra-short lifetimes (blinky "pop" look) if a job gets sped up aggressively.
      const lifetime = Math.max(0.15, logicalTicks / 20);
      
      // Calculate visual speed from distance and lifetime
      // This ensures visual and logical are perfectly in sync
      // Speed will scale with distance to maintain constant appearance
      const speed = dist / lifetime;
      
      // Get tier from source prism (fromBlock) for orb color tinting
      // This ensures orbs are colored based on the tier of the prism that fired them
      const sourceTier = fromBlock && isPrismBlock(fromBlock) 
        ? getPrismTier(fromBlock)
        : level; // Fallback to job level if fromBlock is not a prism
      
      const color = isFluxTypeId(itemTypeId)
        ? { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }
        : getOrbColor(sourceTier);
      if (typeof molang.setSpeedAndDirection === "function") {
        molang.setSpeedAndDirection("variable.chaos_move", speed, dir);
      }
      molang.setFloat("variable.chaos_move.speed", speed);
      molang.setFloat("variable.chaos_move.direction_x", dir.x);
      molang.setFloat("variable.chaos_move.direction_y", dir.y);
      molang.setFloat("variable.chaos_move.direction_z", dir.z);
      molang.setFloat("variable.chaos_color_r", color.r);
      molang.setFloat("variable.chaos_color_g", color.g);
      molang.setFloat("variable.chaos_color_b", color.b);
      molang.setFloat("variable.chaos_color_a", color.a);
      molang.setFloat("variable.chaos_lifetime", lifetime);

      const pos = {
        x: from.x + 0.5,
        y: from.y + 0.5,
        z: from.z + 0.5,
      };
      queueFxParticle(dim, fxId, pos, molang);
      if (debugEnabled && debugState) debugState.orbSpawns++;
      return true;
    } catch (e) {
      return false;
    }
  }

  function enqueueFluxTransferFx(pathBlocks, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathBlocks) || pathBlocks.length < 2) return;
      if (!Array.isArray(fluxFxInflight) || fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = pathBlocks[s]?.dimension?.id;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const b = pathBlocks[i];
        if (!b) continue;
        const loc = b.location;
        if (!loc) continue;
        path.push({ x: loc.x, y: loc.y, z: loc.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const dim = getDimensionCached ? getDimensionCached(dimId) : null;
      if (!dim) return;
      const segments = buildFluxFxSegments(dim, path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch (e) {
      // ignore
    }
  }

  function enqueueFluxTransferFxPositions(pathPositions, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathPositions) || pathPositions.length < 2) return;
      if (!Array.isArray(fluxFxInflight) || fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = insertInfo?.dimId || pathPositions[s]?.dimId || null;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const p = pathPositions[i];
        if (!p) continue;
        path.push({ x: p.x, y: p.y, z: p.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const dim = getDimensionCached ? getDimensionCached(dimId) : null;
      if (!dim) return;
      const segments = buildFluxFxSegments(dim, path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch (e) {
      // ignore
    }
  }

  return {
    spawnOrbStep,
    enqueueFluxTransferFx,
    enqueueFluxTransferFxPositions,
    spawnLevelUpBurst,
    normalizeDir,
    getOrbColor,
  };
}


