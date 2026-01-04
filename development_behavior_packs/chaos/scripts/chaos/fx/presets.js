// scripts/chaos/fx/presets.js
import { FX } from "./fxConfig.js";

function cloneFx(base, overrides) {
  const next = {};
  if (base && typeof base === "object") {
    for (const k in base) next[k] = base[k];
  }
  if (overrides && typeof overrides === "object") {
    for (const k2 in overrides) next[k2] = overrides[k2];
  }
  return next;
}

export function makeVisionFx() {
  // Silent beam-only FX for linkVision
  return cloneFx(FX, {
    sfxPair: null,
    sfxUnpair: null,
    particleSuccess: null,
    particleUnpair: null,
    particleBeam: FX.particleBeam,
    particleBeamUnpair: FX.particleBeam,
  });
}

export function makeUnpairFx() {
  // Unpair visuals + sound (pair sound off)
  return cloneFx(FX, {
    _unpair: true,
    sfxPair: null,
    sfxUnpair: FX.sfxUnpair,
    particleSuccess: null,
    particleUnpair: FX.particleUnpair,
    particleBeam: null,
    particleBeamUnpair: FX.particleBeamUnpair,
  });
}
