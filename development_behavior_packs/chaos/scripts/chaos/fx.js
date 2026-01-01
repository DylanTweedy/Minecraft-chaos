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

function drawBeam(dimension, from, to, particleId) {
  try {
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
      safeSpawnParticle(dimension, particleId, {
        x: from.x + dx * t,
        y: from.y + dy * t,
        z: from.z + dz * t,
      });
    }
  } catch {
    // ignore
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

    safePlaySound(player, soundId, toPos);

    const a = { x: fromPos.x + 0.5, y: fromPos.y + 0.5, z: fromPos.z + 0.5 };
    const b = { x: toPos.x + 0.5, y: toPos.y + 0.5, z: toPos.z + 0.5 };

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
    drawBeam(dim, from, to, fx && fx.particleTransferBeam);

    const orb = fx && fx.particleTransferItem;
    if (!orb) return;

    // Direction vector
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= 0.0001) return;

    const dir = { x: dx / len, y: dy / len, z: dz / len };

    let molang = null;
    if (fx && typeof fx.makeMolang === "function") {
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
