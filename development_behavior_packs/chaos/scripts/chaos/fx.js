// scripts/chaos/fx.js
// IMPORTANT: keep this file "safe": no imports, no DP access.
// Everything is best-effort and wrapped so it can't crash the script.

function safePlaySound(player, soundId, location) {
  try {
    if (!soundId) return;
    if (location) {
      player.playSound(soundId, { location });
    } else {
      player.playSound(soundId);
    }
  } catch {
    // ignore
  }
}

function safeSpawnParticle(dimension, particleId, location) {
  try {
    if (!dimension || !particleId || !location) return;
    dimension.spawnParticle(particleId, location);
  } catch {
    // ignore
  }
}

function drawBeam(dimension, from, to, particleId) {
  if (!dimension || !from || !to || !particleId) return;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;

  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= 0.001) return;

  const step = 0.35;
  const steps = Math.max(1, Math.floor(dist / step));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pos = {
      x: from.x + dx * t,
      y: from.y + dy * t,
      z: from.z + dz * t,
    };
    safeSpawnParticle(dimension, particleId, pos);
  }
}

// ---------- Public FX ----------

export function fxSelectInput(player, block, fx) {
  try {
    const dim = block.dimension;
    const loc = block.location;

    safePlaySound(player, fx && fx.sfxSelect, loc);

    const pLoc = { x: loc.x + 0.5, y: loc.y + 0.8, z: loc.z + 0.5 };
    safeSpawnParticle(dim, fx && fx.particleSelect, pLoc);
  } catch {
    // ignore
  }
}

export function fxPairSuccess(player, fromPos, toPos, fx) {
  try {
    const dim = player.dimension;

    const isUnpair = !!(fx && fx._unpair);

    const soundId = isUnpair
      ? (fx.sfxUnpair || fx.sfxPair)
      : fx.sfxPair;

    const particleSuccess = isUnpair
      ? (fx.particleUnpair || fx.particleSuccess)
      : fx.particleSuccess;

    const beamParticle = isUnpair
      ? (fx.particleBeamUnpair || fx.particleBeam)
      : fx.particleBeam;

    safePlaySound(player, soundId, toPos);

    const a = { x: fromPos.x + 0.5, y: fromPos.y + 0.8, z: fromPos.z + 0.5 };
    const b = { x: toPos.x + 0.5, y: toPos.y + 0.8, z: toPos.z + 0.5 };

    safeSpawnParticle(dim, particleSuccess, a);
    safeSpawnParticle(dim, particleSuccess, b);

    drawBeam(dim, a, b, beamParticle);

    if (isUnpair && fx && fx.particleUnpairExtra) {
      safeSpawnParticle(dim, fx.particleUnpairExtra, a);
      safeSpawnParticle(dim, fx.particleUnpairExtra, b);
    }
  } catch {
    // ignore
  }
}
