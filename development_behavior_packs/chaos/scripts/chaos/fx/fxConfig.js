// scripts/chaos/fx/fxConfig.js
import { MolangVariableMap } from "@minecraft/server";

import {
  SFX_SELECT_INPUT,
  SFX_PAIR_SUCCESS,
  SFX_UNPAIR,
  PARTICLE_SELECT_INPUT,
  PARTICLE_PAIR_SUCCESS,
  PARTICLE_BEAM,
  PARTICLE_UNPAIR_SUCCESS,
  PARTICLE_UNPAIR_BEAM,
} from "../core/constants.js";

function makeColorMolang(r, g, b, a) {
  const m = new MolangVariableMap();
  m.setFloat("variable.chaos_color_r", r);
  m.setFloat("variable.chaos_color_g", g);
  m.setFloat("variable.chaos_color_b", b);
  m.setFloat("variable.chaos_color_a", a);
  return m;
}

// Must match transfer_orb.json lifetime (seconds)
const ORB_LIFETIME_SECONDS = 1.0;

// Cosmetic clamps so it doesn't look absurd for long/short links
const ORB_SPEED_MIN = 0.6;
const ORB_SPEED_MAX = 12.0;

export const FX = {
  sfxSelect: (SFX_SELECT_INPUT != null ? SFX_SELECT_INPUT : "random.levelup"),
  sfxPair: (SFX_PAIR_SUCCESS != null ? SFX_PAIR_SUCCESS : "random.levelup"),
  sfxUnpair: (SFX_UNPAIR != null ? SFX_UNPAIR : "random.anvil_land"),

  particleSelect: PARTICLE_SELECT_INPUT,
  particleSuccess: PARTICLE_PAIR_SUCCESS,
  particleBeam: PARTICLE_BEAM,

  particleUnpair: PARTICLE_UNPAIR_SUCCESS,
  particleBeamUnpair: PARTICLE_UNPAIR_BEAM,

  particleTransferBeam: "chaos:transfer_beam",
  particleTransferItem: "chaos:transfer_orb",

  // Default tinting. Override in presets for vision if needed.
  beamMolang: () => makeColorMolang(0.2, 0.8, 1.0, 1.0),        // link (cyan)
  beamMolangUnpair: () => makeColorMolang(1.0, 0.35, 0.2, 1.0), // unlink (red-orange)
  transferBeamMolang: () => makeColorMolang(1.0, 0.85, 0.2, 1.0), // transfer (gold)

  // Signature supports extra args (fx.js will pass them):
  // makeMolang(dir, fromBlock, toBlock, itemTypeId)
  makeMolang: (dir, fromBlock, toBlock /*, itemTypeId */) => {
    try {
      if (!dir || !fromBlock || !toBlock) return null;

      const dx = Number(dir.x);
      const dy = Number(dir.y);
      const dz = Number(dir.z);
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;

      // Compute distance between the same spawn points fx.js uses:
      const ax = fromBlock.location.x + 0.5;
      const ay = fromBlock.location.y + 1.05;
      const az = fromBlock.location.z + 0.5;

      const bx = toBlock.location.x + 0.5;
      const by = toBlock.location.y + 1.05;
      const bz = toBlock.location.z + 0.5;

      const ddx = bx - ax;
      const ddy = by - ay;
      const ddz = bz - az;

      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (!Number.isFinite(dist) || dist <= 0.0001) return null;

      // speed = distance / lifetime (blocks per second)
      let speed = dist / ORB_LIFETIME_SECONDS;

      // Clamp to keep visuals sane
      if (speed < ORB_SPEED_MIN) speed = ORB_SPEED_MIN;
      if (speed > ORB_SPEED_MAX) speed = ORB_SPEED_MAX;

      const m = new MolangVariableMap();
      m.setSpeedAndDirection("variable.chaos_move", speed, { x: dx, y: dy, z: dz });
      return m;
    } catch {
      return null;
    }
  },
};
