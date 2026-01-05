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

export const BEAM_COLORS = {
  link: [0.2, 0.8, 1.0, 1.0],     // cyan
  unlink: [1.0, 0.35, 0.2, 1.0],  // red-orange
  transfer: [1.0, 0.85, 0.2, 1.0],// gold
  vision: [0.4, 0.7, 1.0, 1.0],   // soft blue
};

export function makeBeamMolang(color) {
  const c = Array.isArray(color) ? color : [1, 1, 1, 1];
  const m = new MolangVariableMap();
  m.setFloat("variable.chaos_color_r", c[0]);
  m.setFloat("variable.chaos_color_g", c[1]);
  m.setFloat("variable.chaos_color_b", c[2]);
  m.setFloat("variable.chaos_color_a", c[3]);
  return m;
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
    beamFxScale: 1.0,
    beamMolang: () => makeBeamMolang(BEAM_COLORS.vision),
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
    beamFxScale: 0.5,
    beamMolangUnpair: () => makeBeamMolang(BEAM_COLORS.unlink),
  });
}

export function makeLinkFx() {
  return cloneFx(FX, {
    particleSuccess: FX.particleSuccess,
    beamFxScale: 0.5,
    beamMolang: () => makeBeamMolang(BEAM_COLORS.link),
  });
}

export function makeTransferFx() {
  return cloneFx(FX, {
    beamFxScale: 0.4,
    transferBeamMolang: () => makeBeamMolang(BEAM_COLORS.transfer),
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
    beamFxScale: 0.5,
    ...(overrides || {}),
  });
}
