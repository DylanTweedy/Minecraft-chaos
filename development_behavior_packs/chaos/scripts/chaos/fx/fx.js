// scripts/chaos/fx.js
// IMPORTANT: keep this file "safe": no imports, no DP access.
// Everything is best-effort and wrapped so it can't crash the script.

function safePlaySound(player, soundId, location) {
  try {
    if (!soundId) return;
    if (!player) return;
    if (location) player.playSound(soundId, { location });
    else player.playSound(soundId);
  } catch {
    // ignore
  }
}

function safePlaySoundAt(dimension, soundId, location) {
  try {
    if (!soundId || !dimension || !location) return;
    if (typeof dimension.playSound === "function") {
      dimension.playSound(soundId, location);
    }
  } catch {
    // ignore
  }
}

function looksLikeMolangVariableMap(molang) {
  try {
    if (!molang) return false;
    return (
      typeof molang.setFloat === "function" ||
      typeof molang.setVector3 === "function" ||
      typeof molang.setColorRGBA === "function" ||
      typeof molang.setSpeedAndDirection === "function"
    );
  } catch {
    return false;
  }
}

const _fxQueue = [];
let _fxQueueEnabled = false;
let _fxQueueMaxPerTick = 100;
let _fxQueueMaxQueued = 2000;

export function configureFxQueue(enabled, maxPerTick, maxQueued) {
  _fxQueueEnabled = !!enabled;
  const cap = Number(maxPerTick);
  if (Number.isFinite(cap) && cap > 0) _fxQueueMaxPerTick = cap | 0;
  const maxQ = Number(maxQueued);
  if (Number.isFinite(maxQ) && maxQ > 0) _fxQueueMaxQueued = maxQ | 0;
}

export function drainFxQueue(maxPerTickOverride) {
  const cap = Number.isFinite(maxPerTickOverride) && maxPerTickOverride > 0
    ? (maxPerTickOverride | 0)
    : _fxQueueMaxPerTick;
  if (cap <= 0 || _fxQueue.length === 0) return;
  const next = [];
  let spawned = 0;
  for (let i = 0; i < _fxQueue.length; i++) {
    const item = _fxQueue[i];
    const delay = item.delayTicks | 0;
    if (delay > 0) {
      item.delayTicks = delay - 1;
      next.push(item);
      continue;
    }
    if (spawned < cap) {
      const molang = resolveMolang(item.molang);
      rawSpawnParticle(item.dimension, item.particleId, item.location, molang);
      spawned++;
    } else {
      next.push(item);
    }
  }
  _fxQueue.length = 0;
  for (let i = 0; i < next.length; i++) _fxQueue.push(next[i]);
}

function rawSpawnParticle(dimension, particleId, location, molang) {
  try {
    if (!dimension || !particleId || !location) return;
    if (molang) {
      try {
        dimension.spawnParticle(particleId, location, molang);
        return;
      } catch {
        // fall through to spawn without molang
      }
    }
    dimension.spawnParticle(particleId, location);
  } catch {
    // ignore
  }
}

function safeSpawnParticle(dimension, particleId, location, molang, delayTicks) {
  if (_fxQueueEnabled) {
    if (_fxQueue.length >= _fxQueueMaxQueued) return;
    const delay = Math.max(0, delayTicks | 0);
    _fxQueue.push({ dimension, particleId, location, molang, delayTicks: delay });
    return;
  }
  const resolved = resolveMolang(molang);
  rawSpawnParticle(dimension, particleId, location, resolved);
}

export function queueFxParticle(dimension, particleId, location, molang, delayTicks) {
  safeSpawnParticle(dimension, particleId, location, molang, delayTicks);
}
function resolveMolang(molang) {
  if (typeof molang === "function") {
    try { return molang(); } catch { return null; }
  }
  return molang ?? null;
}

function applyBeamMotionMolang(molang, dir, dist, speed) {
  try {
    if (!molang || !dir) return molang ?? null;
    const distSafe = Math.max(0.01, Number(dist) || 0);
    const speedSafe = Math.max(0.1, Number(speed) || 0);
    if (typeof molang.setSpeedAndDirection === "function") {
      molang.setSpeedAndDirection("variable.chaos_move", speedSafe, { x: dir.x, y: dir.y, z: dir.z });
    }
    if (typeof molang.setFloat === "function") {
      molang.setFloat("variable.chaos_dist", distSafe);
      molang.setFloat("variable.chaos_speed", speedSafe);
      molang.setFloat("variable.chaos_lifetime", distSafe / Math.max(0.05, speedSafe));
      molang.setFloat("variable.chaos_move.speed", speedSafe);
      molang.setFloat("variable.chaos_move.direction_x", dir.x);
      molang.setFloat("variable.chaos_move.direction_y", dir.y);
      molang.setFloat("variable.chaos_move.direction_z", dir.z);
      molang.setFloat("variable.chaos_dir_x", dir.x);
      molang.setFloat("variable.chaos_dir_y", dir.y);
      molang.setFloat("variable.chaos_dir_z", dir.z);
    }
    return molang;
  } catch {
    return molang ?? null;
  }
}

function normalizeVec(v) {
  if (!v) return null;
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(len) || len <= 0.000001) return null;
  return { x: x / len, y: y / len, z: z / len };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function makeBasisFromDir(dir) {
  const d = normalizeVec(dir);
  if (!d) return null;
  const up = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalizeVec(cross(d, up));
  if (!u) return null;
  const v = normalizeVec(cross(d, u));
  if (!v) return null;
  return { dir: d, u, v };
}

function jitterVec(pos, mag) {
  const m = Math.max(0, Number(mag) || 0);
  if (m <= 0) return pos;
  const r = () => (Math.random() * 2 - 1) * m;
  return {
    x: pos.x + r(),
    y: pos.y + r(),
    z: pos.z + r(),
  };
}

function computeStepWithCap(dist, step, maxParticles) {
  let s = Math.max(0.05, Number(step) || 0.35);
  if (Number.isFinite(maxParticles) && maxParticles > 0) {
    const minStep = dist / Math.max(1, Math.floor(maxParticles));
    if (minStep > s) s = minStep;
  }
  return s;
}

function spawnBeamLine(dimension, from, to, particleId, molang, step, jitterMag, maxParticles) {
  try {
    if (!dimension || !from || !to || !particleId) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;

    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(dist) || dist <= 0.001) return;

    const s = computeStepWithCap(dist, step, maxParticles);
    const steps = Math.max(1, Math.floor(dist / s));
    const jitter = Math.max(0, Number(jitterMag) || 0);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let pos = {
        x: from.x + dx * t,
        y: from.y + dy * t,
        z: from.z + dz * t,
      };
      if (jitter > 0) pos = jitterVec(pos, jitter);
      safeSpawnParticle(dimension, particleId, pos, molang);
    }
  } catch {
    // ignore
  }
}

function randomPointOnFace(origin, dir, radius) {
  const r = Math.max(0, Number(radius) || 0);
  if (r <= 0) return origin;
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);

  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (ay >= ax && ay >= az) {
    rx = (Math.random() * 2 - 1) * r;
    rz = (Math.random() * 2 - 1) * r;
  } else if (ax >= az) {
    ry = (Math.random() * 2 - 1) * r;
    rz = (Math.random() * 2 - 1) * r;
  } else {
    rx = (Math.random() * 2 - 1) * r;
    ry = (Math.random() * 2 - 1) * r;
  }
  return { x: origin.x + rx, y: origin.y + ry, z: origin.z + rz };
}

function spawnParticlesAtPoint(dimension, pos, particleId, molang, count, jitterMag, faceDir, faceRadius, immediate, delayStep) {
  try {
    if (!dimension || !pos || !particleId) return;
    const n = Math.max(1, count | 0);
    const jitter = Math.max(0, Number(jitterMag) || 0);
    const step = Math.max(0, delayStep | 0);
    for (let i = 0; i < n; i++) {
      let p = faceDir ? randomPointOnFace(pos, faceDir, faceRadius) : pos;
      if (jitter > 0) p = jitterVec(p, jitter);
      const delay = step > 0 ? (i * step) : 0;
      if (immediate && delay <= 0) {
        rawSpawnParticle(dimension, particleId, p, resolveMolang(molang));
      } else {
        safeSpawnParticle(dimension, particleId, p, molang, delay);
      }
    }
  } catch {
    // ignore
  }
}

function spawnLayeredBeamFx(dimension, a, b, fx, opts) {
  const molang = resolveMolang(opts?.molang ?? fx?.beamMolang);
  const coreParticle = (opts?.particleCore ?? fx?.particleBeamCore ?? fx?.particleBeam);
  const hazeParticle = (opts?.particleHaze ?? fx?.particleBeamHaze);
  const faceDir = opts?.faceDir;
  const faceRadius = opts?.faceRadius ?? 0;

  const step = opts?.step ?? fx?.beamStep;
  const hazeStep = opts?.hazeStep ?? ((Number(step) || 0.35) * 1.6);
  const jitter = opts?.jitter ?? fx?.jitterMagnitude ?? 0;

  const maxParticles = opts?.maxParticles;
  const maxHazeParticles = opts?.maxHazeParticles ?? (Number.isFinite(maxParticles) ? Math.max(1, Math.floor(maxParticles * 0.6)) : undefined);

  const coreCount = Math.max(1, Math.min(6, Number.isFinite(maxParticles) ? Math.floor(maxParticles / 2) : 3));
  const hazeCount = Math.max(1, Math.min(5, Number.isFinite(maxHazeParticles) ? Math.floor(maxHazeParticles / 2) : 3));
  const startOnlyCore = !!opts?.startOnlyCore;
  const startOnlyHaze = !!opts?.startOnlyHaze;

  if (coreParticle) {
    if (startOnlyCore) {
      spawnParticlesAtPoint(dimension, a, coreParticle, molang, coreCount, jitter * 0.5, faceDir, faceRadius);
    } else {
      spawnBeamLine(dimension, a, b, coreParticle, molang, step, jitter * 0.5, maxParticles);
    }
  }
  if (hazeParticle) {
    if (startOnlyHaze) {
      spawnParticlesAtPoint(dimension, a, hazeParticle, molang, hazeCount, jitter, faceDir, faceRadius);
    } else {
      spawnBeamLine(dimension, a, b, hazeParticle, molang, hazeStep, jitter, maxHazeParticles);
    }
  }
}

function spawnSpiralAroundBeamFx(dimension, a, b, fx, opts) {
  try {
    const particleId = opts?.particleId ?? fx?.particleBeamSpiral;
    if (!particleId) return;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(dist) || dist <= 0.001) return;

    const basis = makeBasisFromDir({ x: dx, y: dy, z: dz });
    if (!basis) return;

    const molang = resolveMolang(opts?.molang ?? fx?.beamMolang);

    const step = opts?.step ?? fx?.spiralStep ?? fx?.beamStep;
    const maxParticles = opts?.maxParticles;
    const s = computeStepWithCap(dist, step, maxParticles);
    const steps = Math.max(1, Math.floor(dist / s));

    const jitter = opts?.jitter ?? fx?.jitterMagnitude ?? 0;
    const rMin = opts?.radiusMin ?? fx?.spiralRadiusMin ?? 0.05;
    const rMax = opts?.radiusMax ?? fx?.spiralRadiusMax ?? 0.18;
    const radius = (rMin + rMax) * 0.5;

    const phaseBase = opts?.phaseBase ?? (Math.random() * Math.PI * 2);
    const twist = Number(opts?.twist ?? (Math.PI * 6));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const phase = phaseBase + t * twist;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);

      const ox = (basis.u.x * cosP + basis.v.x * sinP) * radius;
      const oy = (basis.u.y * cosP + basis.v.y * sinP) * radius;
      const oz = (basis.u.z * cosP + basis.v.z * sinP) * radius;

      let pos = {
        x: a.x + dx * t + ox,
        y: a.y + dy * t + oy,
        z: a.z + dz * t + oz,
      };
      if (jitter > 0) pos = jitterVec(pos, jitter);

      if (opts?.immediate) {
        rawSpawnParticle(dimension, particleId, pos, resolveMolang(molang));
      } else {
        safeSpawnParticle(dimension, particleId, pos, molang);
      }
    }
  } catch {
    // ignore
  }
}

function spawnBeamEndpointsFx(dimension, a, b, fx, opts) {
  const molang = resolveMolang(opts?.molang ?? fx?.beamMolang);
  const inputParticle = opts?.particleInput ?? fx?.particleBeamInputCharge;
  const outputParticle = opts?.particleOutput ?? fx?.particleBeamOutputBurst;
  if (!inputParticle && !outputParticle) return;

  const inputCount = opts?.inputCount ?? 3;
  const outputCount = opts?.outputCount ?? 6;
  const inputRadius = opts?.inputRadius ?? 0.15;
  const outputRadius = opts?.outputRadius ?? 0.3;

  if (inputParticle) burstAround(dimension, a, inputParticle, inputCount, inputRadius, molang);
  if (outputParticle) burstAround(dimension, b, outputParticle, outputCount, outputRadius, molang);
}

function pulse01(tickNow, periodTicks) {
  const period = Math.max(1, Number(periodTicks) || 20);
  const t = ((Number(tickNow) || 0) % period) / period;
  return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
}

export function createBeam(dimension, from, to, fx, opts) {
  try {
    if (!dimension || !from || !to) return;

    const beamMolang = resolveMolang(opts?.molang ?? fx?.beamMolang);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(dist) || dist <= 0.0001) return;

    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const flowLifetime = Number(opts?.flowLifetimeSeconds ?? fx?.beamFlowLifetimeSeconds) || 0.8;
    let speed = dist / Math.max(0.05, flowLifetime);
    if (speed < 0.6) speed = 0.6;
    if (speed > 12.0) speed = 12.0;
    const distSafe = Math.max(0.01, dist);
    const speedSafe = Math.max(0.1, speed);

    const beamMotionMolang = applyBeamMotionMolang(beamMolang, dir, distSafe, speedSafe);
    const makeBeamMolang = (typeof fx?.makeBeamMolang === "function")
      ? (() => applyBeamMotionMolang(
        fx.makeBeamMolang({ x: dir.x, y: dir.y, z: dir.z }, distSafe, speedSafe),
        dir,
        distSafe,
        speedSafe
      ) ?? beamMotionMolang)
      : (() => beamMotionMolang);
    const makeCoreMolang = () => {
      const scale = 0.75 + Math.random() * 0.5;
      const m = applyBeamMotionMolang(resolveMolang(makeBeamMolang), dir, distSafe, speedSafe * scale) ?? beamMotionMolang;
      if (m && typeof m.setFloat === "function") {
        m.setFloat("variable.chaos_size_scale", 0.85 + Math.random() * 0.3);
        m.setFloat("variable.chaos_alpha_scale", 0.6 + Math.random() * 0.4);
        m.setFloat("variable.chaos_color_a", 0.4 + Math.random() * 0.3);
      }
      return m;
    };
    const makeHazeMolang = () => {
      const scale = 0.75 + Math.random() * 0.5;
      return applyBeamMotionMolang(resolveMolang(makeBeamMolang), dir, distSafe, speedSafe * scale) ?? beamMotionMolang;
    };
    const makeSpiralMolang = () => {
      const scale = 0.75 + Math.random() * 0.5;
      return applyBeamMotionMolang(resolveMolang(makeBeamMolang), dir, spiralDist, speedSafe * scale) ?? beamMotionMolang;
    };
    const makeChargeMolang = () => {
      const scale = 0.75 + Math.random() * 0.5;
      return applyBeamMotionMolang(resolveMolang(makeBeamMolang), dir, distSafe, speedSafe * scale) ?? beamMotionMolang;
    };

    const scale = Math.max(0, Number(opts?.scale ?? fx?.beamFxScale) || 1);
    const maxParticles = Math.max(6, Math.floor((fx?.maxParticlesPerTick ?? 160) * scale));
    const coreDelayStep = Math.max(0, Number(opts?.coreDelayTicks ?? fx?.beamCoreDelayTicks) || 0);

    const baseStep = Number(opts?.beamStep ?? fx?.beamStep) || 0.35;
    const baseSpiralStep = Number(opts?.spiralStep ?? fx?.spiralStep) || Math.max(baseStep * 2, 0.7);
    const jitter = Number(opts?.jitterMagnitude ?? fx?.jitterMagnitude) || 0;

    const tickNow = opts?.tickNow;
    const pulse = Number.isFinite(tickNow)
      ? pulse01(tickNow, Number(opts?.pulsePeriodTicks ?? fx?.pulsePeriodTicks) || 20)
      : 1;
    const densityScale = 0.7 + 0.6 * pulse;

    const step = baseStep / densityScale;
    const spiralStep = baseSpiralStep / densityScale;

    const endpointsEnabled = opts?.endpoints === true;
    let inputCount = endpointsEnabled ? (opts?.inputCount ?? 2) : 0;
    let outputCount = endpointsEnabled ? (opts?.outputCount ?? 3) : 0;

    const endBudget = endpointsEnabled ? Math.max(0, Math.floor(maxParticles * 0.2)) : 0;
    if (endBudget <= 1) {
      inputCount = 0;
      outputCount = 0;
    } else if ((inputCount + outputCount) > endBudget) {
      inputCount = Math.max(1, Math.floor(endBudget * 0.4));
      outputCount = Math.max(1, endBudget - inputCount);
    }

    const beamBudget = Math.max(0, maxParticles - (inputCount + outputCount));
    const coreBudget = Math.max(2, Math.floor(beamBudget * 0.6));
    const hazeBudget = Math.max(0, Math.floor(beamBudget * 0.25));
    const spiralBudget = Math.max(0, beamBudget - coreBudget - hazeBudget);

    const endpointOffset = Math.max(0, Number(opts?.endpointOffset ?? 0.35));
    const endpointIn = {
      x: from.x + dir.x * endpointOffset,
      y: from.y + dir.y * endpointOffset,
      z: from.z + dir.z * endpointOffset,
    };
    const endpointOut = {
      x: to.x - dir.x * endpointOffset,
      y: to.y - dir.y * endpointOffset,
      z: to.z - dir.z * endpointOffset,
    };

    const faceRadius = opts?.faceRadius ?? 0.35;
    const faceOrigin = {
      x: from.x + dir.x * 0.5,
      y: from.y + dir.y * 0.5,
      z: from.z + dir.z * 0.5,
    };
    const spiralDist = Math.max(0.01, distSafe - (endpointOffset + 0.5));

    const coreParticle = opts?.particleCore ?? fx?.particleBeamCore ?? fx?.particleBeam;
    const hazeParticle = opts?.particleHaze ?? fx?.particleBeamHaze;

    const startCoreCount = Math.max(1, Math.min(6, Math.floor(coreBudget * 0.35)));
    const startHazeCount = Math.max(0, Math.min(5, Math.floor(hazeBudget * 0.35)));

    if (coreParticle) {
      spawnParticlesAtPoint(dimension, faceOrigin, coreParticle, makeCoreMolang, startCoreCount, jitter * 0.5, dir, faceRadius, false, coreDelayStep);
    }
    if (hazeParticle && startHazeCount > 0) {
      spawnParticlesAtPoint(dimension, faceOrigin, hazeParticle, makeHazeMolang, startHazeCount, jitter, dir, faceRadius, true);
    }

    if (spiralBudget > 0) {
      const spiralCount = Math.max(1, Math.min(6, Math.floor(spiralBudget * 0.35)));
      spawnParticlesAtPoint(dimension, faceOrigin, fx?.particleBeamSpiral, makeSpiralMolang, spiralCount, jitter, dir, faceRadius, true);
    }

    if (inputCount > 0 || outputCount > 0) {
      spawnBeamEndpointsFx(dimension, endpointIn, endpointOut, fx, {
        molang: makeChargeMolang,
        inputCount,
        outputCount,
        inputRadius: opts?.inputRadius ?? 0.12,
        outputRadius: opts?.outputRadius ?? 0.2,
      });
    }

    const legacyParticle = opts?.legacyParticle;
    if (legacyParticle) {
      const legacyStep = opts?.legacyStep ?? fx?.beamStep;
      drawBeamParticles(dimension, from, to, legacyParticle, beamMotionMolang, legacyStep);
    }
  } catch {
    // ignore
  }
}

export function drawBeamParticles(dimension, from, to, particleId, molang, stepOverride) {
  try {
    if (!dimension || !from || !to || !particleId) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;

    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= 0.001) return;

    const step = Math.max(0.05, Number(stepOverride) || 0.35);
    const steps = Math.max(1, Math.floor(dist / step));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      safeSpawnParticle(dimension, particleId, {
        x: from.x + dx * t,
        y: from.y + dy * t,
        z: from.z + dz * t,
      }, molang);
    }
  } catch {
    // ignore
  }
}

function burstAround(dimension, center, particleId, count, radius, molang) {
  try {
    if (!dimension || !center || !particleId) return;
    const n = Math.max(1, count | 0);
    const r = Math.max(0, Number(radius) || 0);
    for (let i = 0; i < n; i++) {
      const ox = (Math.random() * 2 - 1) * r;
      const oy = (Math.random() * 2 - 1) * r;
      const oz = (Math.random() * 2 - 1) * r;
      safeSpawnParticle(dimension, particleId, {
        x: center.x + ox,
        y: center.y + oy,
        z: center.z + oz,
      }, molang);
    }
  } catch {
    // ignore
  }
}

function burstMix(dimension, center, mix, molang) {
  try {
    if (!dimension || !center || !Array.isArray(mix)) return;
    for (const entry of mix) {
      if (!entry || !entry.id) continue;
      const count = Math.max(1, entry.count | 0);
      const radius = Math.max(0, Number(entry.radius) || 0);
      const useMolang = entry.molang ?? molang;
      burstAround(dimension, center, entry.id, count, radius, useMolang);
    }
  } catch {
    // ignore
  }
}

function resolveFluxMolang(fx, itemTypeId) {
  try {
    if (!fx) return null;
    const m = fx.fluxMolang;
    if (typeof m === "function") return m(itemTypeId);
    return m || null;
  } catch {
    return null;
  }
}

// ---------- Public FX ----------

export function fxSelectInput(player, block, fx) {
  try {
    const dim = block.dimension;
    const loc = block.location;

    safePlaySound(player, fx && fx.sfxSelect, loc);

    safeSpawnParticle(dim, fx && fx.particleSelect, {
      x: loc.x + 0.5,
      y: loc.y + 0.8,
      z: loc.z + 0.5,
    });
  } catch {
    // ignore
  }
}

export function fxPairSuccess(player, fromPos, toPos, fx) {
  try {
    const dim = player.dimension;

    const isUnpair = !!(fx && fx._unpair);

    const soundId = isUnpair ? (fx.sfxUnpair || fx.sfxPair) : fx.sfxPair;
    const particleSuccess = isUnpair
      ? (fx.particleUnpair || fx.particleSuccess)
      : fx.particleSuccess;
    const beamParticle = isUnpair
      ? (fx.particleBeamUnpair || fx.particleBeam)
      : fx.particleBeam;
    let beamMolang = isUnpair
      ? (fx.beamMolangUnpair || fx.beamMolang)
      : fx.beamMolang;
    beamMolang = resolveMolang(beamMolang);

    safePlaySound(player, soundId, toPos);

    const a = { x: fromPos.x + 0.5, y: fromPos.y + 0.5, z: fromPos.z + 0.5 };
    const b = { x: toPos.x + 0.5, y: toPos.y + 0.5, z: toPos.z + 0.5 };

    if (particleSuccess) {
      const burstCount = isUnpair
        ? (fx.unpairBurstCount ?? fx.successBurstCount ?? 6)
        : (fx.successBurstCount ?? 6);
      const burstRadius = isUnpair
        ? (fx.unpairBurstRadius ?? fx.successBurstRadius ?? 0.35)
        : (fx.successBurstRadius ?? 0.35);
      // Small burst around endpoints instead of a single in-block particle
      burstAround(dim, a, particleSuccess, burstCount, burstRadius, beamMolang);
      burstAround(dim, b, particleSuccess, burstCount, burstRadius, beamMolang);
    }

    createBeam(dim, a, b, fx, {
      molang: beamMolang,
      endpoints: true,
      legacyParticle: (beamParticle && fx?.particleBeamCore !== beamParticle) ? beamParticle : null,
    });

    if (isUnpair && fx && fx.particleUnpairExtra) {
      safeSpawnParticle(dim, fx.particleUnpairExtra, a);
      safeSpawnParticle(dim, fx.particleUnpairExtra, b);
    }
  } catch {
    // ignore
  }
}

// ---------- Transfer FX (no scheduling; motion via Molang) ----------
// Signature: (fromBlock, toBlock, itemTypeId, fx)

export function fxTransferItem(fromBlock, toBlock, itemTypeId, fx) {
  try {
    if (!fromBlock || !toBlock) return;

    const dim = fromBlock.dimension;
    if (!dim) return;

    // TRUE CENTER of blocks (beam + orb aligned)
    const from = {
      x: fromBlock.location.x + 0.5,
      y: fromBlock.location.y + 0.5,
      z: fromBlock.location.z + 0.5,
    };

    const to = {
      x: toBlock.location.x + 0.5,
      y: toBlock.location.y + 0.5,
      z: toBlock.location.z + 0.5,
    };

    // Beam first
    const transferStep = fx && (fx.transferBeamStep || fx.beamStep);
    let transferMolang = fx && (fx.transferBeamMolang || fx.beamMolang);
    transferMolang = resolveMolang(transferMolang);

    createBeam(dim, from, to, fx, {
      molang: transferMolang,
      beamStep: transferStep,
      particleCore: fx && fx.particleBeamCore,
      particleHaze: fx && fx.particleBeamHaze,
      endpoints: true,
      legacyParticle: fx && fx.particleTransferBeam,
      scale: (fx?.beamFxScale ?? 1) * 0.8,
    });

    let orb = fx && fx.particleTransferItem;
    if (fx?.particleTransferItemByMode?.attuned) {
      orb = fx.particleTransferItemByMode.attuned;
    }
    let isExoticOrb = false;
    if (itemTypeId && fx?.particleExoticOrbById && fx.particleExoticOrbById[itemTypeId]) {
      orb = fx.particleExoticOrbById[itemTypeId] || orb;
      isExoticOrb = true;
    } else if (itemTypeId && fx?.particleFluxOrbByTier && Array.isArray(fx.particleFluxOrbByTier)) {
      let fluxTier = 0;
      if (itemTypeId === "chaos:flux_1") fluxTier = 1;
      else if (itemTypeId === "chaos:flux_2") fluxTier = 2;
      else if (itemTypeId === "chaos:flux_3") fluxTier = 3;
      else if (itemTypeId === "chaos:flux_4") fluxTier = 4;
      else if (itemTypeId === "chaos:flux_5") fluxTier = 5;
      if (fluxTier > 0) {
        const idx = fluxTier - 1;
        orb = fx.particleFluxOrbByTier[idx] || orb;
      }
    }
    if (!orb) return;

    // Direction vector
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= 0.0001) return;

    const dir = { x: dx / len, y: dy / len, z: dz / len };

    let molang = null;
    if (!isExoticOrb && fx && typeof fx.makeMolang === "function") {
      try {
        molang = fx.makeMolang(dir, fromBlock, toBlock, itemTypeId);
      } catch {
        molang = null;
      }
    }

    // Tiny forward nudge so it doesn't Z-fight with the beam origin
    const spawn = {
      x: from.x + dir.x * 0.15,
      y: from.y + dir.y * 0.15,
      z: from.z + dir.z * 0.15,
    };

    safeSpawnParticle(dim, orb, spawn, molang);
  } catch {
    // ignore
  }
}

// ---------- Flux FX ----------

export function fxFluxOrbStep(fromBlock, toBlock, fx, tier) {
  try {
    if (!fromBlock || !toBlock) return;

    const dim = fromBlock.dimension;
    if (!dim) return;

    let orb = fx?.particleFluxOrb || fx?.particleTransferItem;
    if (fx?.particleFluxOrbByTier && Array.isArray(fx.particleFluxOrbByTier)) {
      const idx = Math.max(1, Math.min(5, tier | 0)) - 1;
      orb = fx.particleFluxOrbByTier[idx] || orb;
    }
    if (!orb) return;

    const from = {
      x: fromBlock.location.x + 0.5,
      y: fromBlock.location.y + 0.5,
      z: fromBlock.location.z + 0.5,
    };
    const to = {
      x: toBlock.location.x + 0.5,
      y: toBlock.location.y + 0.5,
      z: toBlock.location.z + 0.5,
    };

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= 0.0001) return;

    const dir = { x: dx / len, y: dy / len, z: dz / len };

    let molang = null;
    if (fx && typeof fx.makeMolang === "function") {
      try {
        molang = fx.makeMolang(dir, fromBlock, toBlock, null);
      } catch {
        molang = null;
      }
    }

    const spawn = {
      x: from.x + dir.x * 0.15,
      y: from.y + dir.y * 0.15,
      z: from.z + dir.z * 0.15,
    };
    safeSpawnParticle(dim, orb, spawn, molang);
  } catch {
    // ignore
  }
}

export function fxFluxGenerate(block, fx) {
  try {
    if (!block || fx?.fluxFxEnabled === false) return;
    const loc = block.location;
    const center = { x: loc.x + 0.5, y: loc.y + 0.7, z: loc.z + 0.5 };
    const molang = resolveFluxMolang(fx, null);
    if (Array.isArray(fx?.burstMixFluxGenerate) && fx.burstMixFluxGenerate.length > 0) {
      burstMix(block.dimension, center, fx.burstMixFluxGenerate, molang);
      return;
    }
    const particleId = fx?.particleFluxGenerate;
    if (!particleId) return;
    burstAround(block.dimension, center, particleId, fx?.fluxGenerateBurstCount ?? 4, fx?.fluxGenerateBurstRadius ?? 0.2, molang);
  } catch {
    // ignore
  }
}

export function fxFluxRefine(block, fx, itemTypeId) {
  try {
    if (!block || fx?.fluxFxEnabled === false) return;
    let particleId = fx?.particleFluxRefine;
    if (itemTypeId && fx?.particleFluxRefineByTier && Array.isArray(fx.particleFluxRefineByTier)) {
      let tier = 0;
      if (itemTypeId === "chaos:flux_1") tier = 1;
      else if (itemTypeId === "chaos:flux_2") tier = 2;
      else if (itemTypeId === "chaos:flux_3") tier = 3;
      else if (itemTypeId === "chaos:flux_4") tier = 4;
      else if (itemTypeId === "chaos:flux_5") tier = 5;
      if (tier > 0) {
        const idx = tier - 1;
        particleId = fx.particleFluxRefineByTier[idx] || particleId;
      }
    }
    const loc = block.location;
    const center = { x: loc.x + 0.5, y: loc.y + 0.7, z: loc.z + 0.5 };
    const molang = resolveFluxMolang(fx, itemTypeId);
    if (itemTypeId && Array.isArray(fx?.burstMixFluxRefineByTier)) {
      let tier = 0;
      if (itemTypeId === "chaos:flux_1") tier = 1;
      else if (itemTypeId === "chaos:flux_2") tier = 2;
      else if (itemTypeId === "chaos:flux_3") tier = 3;
      else if (itemTypeId === "chaos:flux_4") tier = 4;
      else if (itemTypeId === "chaos:flux_5") tier = 5;
      if (tier > 0) {
        const mix = fx.burstMixFluxRefineByTier[tier - 1];
        if (Array.isArray(mix) && mix.length > 0) {
          burstMix(block.dimension, center, mix, molang);
          return;
        }
      }
    }
    if (!particleId) return;
    burstAround(block.dimension, center, particleId, fx?.fluxRefineBurstCount ?? 5, fx?.fluxRefineBurstRadius ?? 0.25, molang);
  } catch {
    // ignore
  }
}

export function fxFluxMutate(block, fx, itemTypeId) {
  try {
    if (!block || fx?.fluxFxEnabled === false) return;
    let particleId = fx?.particleFluxMutate;
    if (itemTypeId && fx?.particleFluxMutateById && fx.particleFluxMutateById[itemTypeId]) {
      particleId = fx.particleFluxMutateById[itemTypeId] || particleId;
    }
    if (itemTypeId && fx?.burstMixFluxMutateById && fx.burstMixFluxMutateById[itemTypeId]) {
      const loc = block.location;
      const center = { x: loc.x + 0.5, y: loc.y + 0.7, z: loc.z + 0.5 };
      burstMix(block.dimension, center, fx.burstMixFluxMutateById[itemTypeId], resolveFluxMolang(fx, itemTypeId));
      if (fx?.sfxFluxMutate) safePlaySoundAt(block.dimension, fx.sfxFluxMutate, loc);
      return;
    }
    const soundId = fx?.sfxFluxMutate;
    if (!particleId && !soundId) return;

    const loc = block.location;
    const molang = resolveFluxMolang(fx, itemTypeId);
    if (particleId) {
      burstAround(block.dimension, {
        x: loc.x + 0.5,
        y: loc.y + 0.7,
        z: loc.z + 0.5,
      }, particleId, fx?.fluxMutateBurstCount ?? 6, fx?.fluxMutateBurstRadius ?? 0.3, molang);
    }
    if (soundId) safePlaySoundAt(block.dimension, soundId, loc);
  } catch {
    // ignore
  }
}
