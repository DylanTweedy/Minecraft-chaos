// scripts/chaos/fx/beam.js
import { drawBeamParticles } from "./fx.js";

function centerBlockLocation(block) {
  return {
    x: block.location.x + 0.5,
    y: block.location.y + 0.5,
    z: block.location.z + 0.5,
  };
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

function safeSpawnParticle(dimension, particleId, location, molang) {
  try {
    if (!dimension || !particleId || !location) return;
    if (looksLikeMolangVariableMap(molang)) {
      dimension.spawnParticle(particleId, location, molang);
    } else {
      dimension.spawnParticle(particleId, location);
    }
  } catch {
    // ignore
  }
}

function resolveMolang(molang) {
  if (typeof molang === "function") {
    try { return molang(); } catch { return null; }
  }
  return molang ?? null;
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

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
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

function spawnBurst(dimension, center, particleId, count, radius, molang) {
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

export function pulse01(tickNow, periodTicks) {
  const period = Math.max(1, Number(periodTicks) || 20);
  const t = ((Number(tickNow) || 0) % period) / period;
  return 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
}

export function jitterVec(pos, mag) {
  if (!pos) return pos;
  const m = Math.max(0, Number(mag) || 0);
  if (m <= 0) return { x: pos.x, y: pos.y, z: pos.z };
  const r = () => (Math.random() * 2 - 1) * m;
  return {
    x: pos.x + r(),
    y: pos.y + r(),
    z: pos.z + r(),
  };
}

export function makeBasisFromDir(dir) {
  const d = normalizeVec(dir);
  if (!d) return null;
  const up = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalizeVec(cross(d, up));
  if (!u) return null;
  const v = normalizeVec(cross(d, u));
  if (!v) return null;
  return { dir: d, u, v };
}

export function spawnLayeredBeam(dimension, a, b, opts) {
  const fx = opts && opts.fx;
  const molang = resolveMolang((opts && opts.molang) ?? (fx && fx.beamMolang));

  const coreParticle = (opts && opts.particleCore) || (fx && fx.particleBeamCore) || (fx && fx.particleBeam);
  const hazeParticle = (opts && opts.particleHaze) || (fx && fx.particleBeamHaze);

  const step = (opts && opts.step) ?? (fx && fx.beamStep);
  const hazeStep = (opts && opts.hazeStep) ?? ((Number(step) || 0.35) * 1.6);
  const jitter = (opts && opts.jitter) ?? (fx && fx.jitterMagnitude) ?? 0;

  const maxParticles = opts && opts.maxParticles;
  const maxHazeParticles = (opts && opts.maxHazeParticles) ?? (Number.isFinite(maxParticles) ? Math.max(1, Math.floor(maxParticles * 0.6)) : undefined);

  if (coreParticle) {
    spawnBeamLine(dimension, a, b, coreParticle, molang, step, jitter * 0.5, maxParticles);
  }
  if (hazeParticle) {
    spawnBeamLine(dimension, a, b, hazeParticle, molang, hazeStep, jitter, maxHazeParticles);
  }
}

export function spawnSpiralAroundBeam(dimension, a, b, opts, tickNow) {
  try {
    if (!dimension || !a || !b) return;

    const fx = opts && opts.fx;
    const particleId = (opts && opts.particleId) || (fx && fx.particleBeamSpiral);
    if (!particleId) return;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(dist) || dist <= 0.001) return;

    const basis = makeBasisFromDir({ x: dx, y: dy, z: dz });
    if (!basis) return;

    const molang = resolveMolang((opts && opts.molang) ?? (fx && fx.beamMolang));

    const step = (opts && opts.step) ?? (fx && fx.spiralStep) ?? (fx && fx.beamStep);
    const maxParticles = opts && opts.maxParticles;
    const s = computeStepWithCap(dist, step, maxParticles);
    const steps = Math.max(1, Math.floor(dist / s));

    const jitter = (opts && opts.jitter) ?? (fx && fx.jitterMagnitude) ?? 0;
    const rMin = (opts && opts.radiusMin) ?? (fx && fx.spiralRadiusMin) ?? 0.05;
    const rMax = (opts && opts.radiusMax) ?? (fx && fx.spiralRadiusMax) ?? 0.18;

    const pulse = (opts && opts.pulse01) ?? pulse01(tickNow, (opts && opts.pulsePeriodTicks) ?? (fx && fx.pulsePeriodTicks));
    const radius = lerp(rMin, rMax, clamp01(pulse));

    const twist = Number((opts && opts.twist) ?? (Math.PI * 6));
    const phaseSpeed = Number((opts && opts.phaseSpeed) ?? 0.25);
    const phaseBase = (Number(tickNow) || 0) * phaseSpeed;

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

      safeSpawnParticle(dimension, particleId, pos, molang);
    }
  } catch {
    // ignore
  }
}

export function spawnBeamEndpoints(dimension, a, b, opts) {
  const fx = opts && opts.fx;
  const molang = resolveMolang((opts && opts.molang) ?? (fx && fx.beamMolang));

  const inputParticle = (opts && opts.particleInput) || (fx && fx.particleBeamInputCharge) || (fx && fx.particleBeamCore) || (fx && fx.particleBeam);
  const outputParticle = (opts && opts.particleOutput) || (fx && fx.particleBeamOutputBurst) || (fx && fx.particleBeamCore) || (fx && fx.particleBeam);

  const inputCount = (opts && opts.inputCount) ?? 3;
  const outputCount = (opts && opts.outputCount) ?? 6;
  const inputRadius = (opts && opts.inputRadius) ?? 0.15;
  const outputRadius = (opts && opts.outputRadius) ?? 0.3;

  if (inputParticle) spawnBurst(dimension, a, inputParticle, inputCount, inputRadius, molang);
  if (outputParticle) spawnBurst(dimension, b, outputParticle, outputCount, outputRadius, molang);
}

export function drawBeamBetweenPoints(dimension, from, to, fx, opts) {
  const particleId = opts?.particleId ?? fx?.particleBeam;
  let molang = opts?.molang ?? fx?.beamMolang;
  if (typeof molang === "function") {
    try { molang = molang(); } catch { molang = null; }
  }
  const step = opts?.step ?? fx?.beamStep;
  drawBeamParticles(dimension, from, to, particleId, molang, step);
}

export function drawBeamBetweenBlocks(fromBlock, toBlock, fx, opts) {
  if (!fromBlock || !toBlock) return;
  const dim = fromBlock.dimension;
  if (!dim) return;

  const from = centerBlockLocation(fromBlock);
  const to = centerBlockLocation(toBlock);
  drawBeamBetweenPoints(dim, from, to, fx, opts);
}
