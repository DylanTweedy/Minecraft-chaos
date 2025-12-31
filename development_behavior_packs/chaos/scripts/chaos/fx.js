// scripts/chaos/fx.js
// Pure helpers. No import-time world/dp/system side effects.

import {
  SFX_SELECT_INPUT,
  SFX_PAIR_SUCCESS,
  PARTICLE_SELECT_INPUT,
  PARTICLE_PAIR_SUCCESS,
  PARTICLE_BEAM,
} from "./constants.js";

function tryPlaySound(player, soundId, loc) {
  if (!soundId) return;
  try {
    player.playSound(soundId, loc);
  } catch {
    // ignore
  }
}

function trySpawnParticle(dimension, particleId, loc) {
  if (!particleId) return;
  try {
    dimension.spawnParticle(particleId, loc);
  } catch {
    // ignore
  }
}

/**
 * Beam fallback: spawn particles along the line A -> B.
 * Works with any particle id; doesn't require fancy molang emitters.
 */
export function spawnBeamBetween(dimension, a, b, particleId = PARTICLE_BEAM) {
  if (!dimension || !particleId || !a || !b) return;

  try {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;

    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;

    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist <= 0.001) return;

    // Tune for looks/perf:
    const step = 0.35; // spacing between particles
    const steps = Math.min(80, Math.max(1, Math.floor(dist / step)));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      trySpawnParticle(dimension, particleId, {
        x: ax + dx * t,
        y: ay + dy * t,
        z: az + dz * t,
      });
    }
  } catch {
    // ignore
  }
}

export function fxSelectInput(player, block) {
  if (!player || !block) return;

  const loc = block.location;

  // Sound (fallback if constant not defined)
  tryPlaySound(player, SFX_SELECT_INPUT ?? "random.levelup", loc);

  // Particle
  trySpawnParticle(player.dimension, PARTICLE_SELECT_INPUT, loc);
}

export function fxPairSuccess(player, inputLoc, outputLoc) {
  if (!player || !inputLoc || !outputLoc) return;

  // Sound at output
  tryPlaySound(player, SFX_PAIR_SUCCESS ?? "random.levelup", outputLoc);

  // Success particle at output
  trySpawnParticle(player.dimension, PARTICLE_PAIR_SUCCESS, outputLoc);

  // Beam between centers
  const a = { x: inputLoc.x + 0.5, y: inputLoc.y + 0.5, z: inputLoc.z + 0.5 };
  const b = { x: outputLoc.x + 0.5, y: outputLoc.y + 0.5, z: outputLoc.z + 0.5 };
  spawnBeamBetween(player.dimension, a, b, PARTICLE_BEAM);
}
