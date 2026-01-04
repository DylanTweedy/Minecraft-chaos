// scripts/chaos/fx/presets.js
import { FX } from "./fxConfig.js";
import { MolangVariableMap } from "@minecraft/server";

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
    beamMolang: () => makeColorMolang(0.4, 0.7, 1.0, 1.0), // vision (soft blue)
  });
}

function makeColorMolang(r, g, b, a) {
  const m = new MolangVariableMap();
  m.setFloat("variable.chaos_color_r", r);
  m.setFloat("variable.chaos_color_g", g);
  m.setFloat("variable.chaos_color_b", b);
  m.setFloat("variable.chaos_color_a", a);
  return m;
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

export function makeBeamFx(overrides) {
  // Beam-only preset (no sfx, no endpoint particles)
  return cloneFx(FX, {
    sfxPair: null,
    sfxUnpair: null,
    particleSuccess: null,
    particleUnpair: null,
    particleBeam: FX.particleBeam,
    particleBeamUnpair: FX.particleBeam,
    ...(overrides || {}),
  });
}
