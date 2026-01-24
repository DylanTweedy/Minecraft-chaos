// scripts/chaos/fx/fxConfig.js
import { MolangVariableMap } from "@minecraft/server";

import {
  SFX_SELECT_INPUT,
  SFX_PAIR_SUCCESS,
  SFX_UNPAIR,
  PARTICLE_SELECT_INPUT,
  PARTICLE_PAIR_SUCCESS,
  PARTICLE_BEAM,
  PARTICLE_BEAM_CORE,
  PARTICLE_BEAM_HAZE,
  PARTICLE_BEAM_SPIRAL,
  PARTICLE_BEAM_INPUT_CHARGE,
  PARTICLE_BEAM_OUTPUT_BURST,
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

function applyBeamMotion(m, dir, dist, speed) {
  if (!m) return;
  const d = (dir && typeof dir.x === "number") ? dir : { x: 0, y: 0, z: 0 };
  const distSafe = Math.max(0.01, Number(dist) || 0);
  const speedSafe = Math.max(0.1, Number(speed) || 0);
  try {
    if (typeof m.setSpeedAndDirection === "function") {
      m.setSpeedAndDirection("variable.chaos_move", speedSafe, { x: d.x, y: d.y, z: d.z });
    }
    if (typeof m.setFloat === "function") {
      m.setFloat("variable.chaos_dist", distSafe);
      m.setFloat("variable.chaos_speed", speedSafe);
      m.setFloat("variable.chaos_lifetime", distSafe / Math.max(0.05, speedSafe));
      m.setFloat("variable.chaos_move.speed", speedSafe);
      m.setFloat("variable.chaos_move.direction_x", d.x);
      m.setFloat("variable.chaos_move.direction_y", d.y);
      m.setFloat("variable.chaos_move.direction_z", d.z);
      m.setFloat("variable.chaos_dir_x", d.x);
      m.setFloat("variable.chaos_dir_y", d.y);
      m.setFloat("variable.chaos_dir_z", d.z);
    }
  } catch {
    // ignore
  }
}

function getBlockLevel(block) {
  try {
    const level = block?.permutation?.getState("chaos:level");
    if (Number.isFinite(level)) return level | 0;
  } catch {
    // ignore
  }
  return 1;
}

function getOrbColor(level) {
  const lvl = Math.min(5, Math.max(1, level | 0));
  const palette = [
    { r: 0.2, g: 0.55, b: 1.0, a: 1.0 },   // L1 blue
    { r: 0.2, g: 0.9, b: 0.35, a: 1.0 },   // L2 green
    { r: 1.0, g: 0.9, b: 0.2, a: 1.0 },    // L3 yellow
    { r: 1.0, g: 0.2, b: 0.2, a: 1.0 },    // L4 red
    { r: 0.75, g: 0.4, b: 0.95, a: 1.0 },  // L5 purple
  ];
  return palette[lvl - 1] || palette[0];
}

function getFluxColor(itemTypeId) {
  switch (itemTypeId) {
    case "chaos:flux_1":
      return { r: 0.2, g: 0.9, b: 0.7, a: 1.0 };
    case "chaos:flux_2":
      return { r: 0.35, g: 0.95, b: 0.5, a: 1.0 };
    case "chaos:flux_3":
      return { r: 0.2, g: 0.8, b: 1.0, a: 1.0 };
    case "chaos:flux_4":
      return { r: 0.5, g: 0.6, b: 1.0, a: 1.0 };
    case "chaos:flux_5":
      return { r: 0.9, g: 0.5, b: 1.0, a: 1.0 };
    case "chaos:exotic_shard":
      return { r: 0.6, g: 0.9, b: 1.0, a: 1.0 };
    case "chaos:exotic_fiber":
      return { r: 0.4, g: 1.0, b: 0.8, a: 1.0 };
    case "chaos:exotic_alloy_lump":
      return { r: 1.0, g: 0.7, b: 0.3, a: 1.0 };
    default:
      return { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
  }
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
  particleBeamCore: PARTICLE_BEAM_CORE,
  particleBeamHaze: PARTICLE_BEAM_HAZE,
  particleBeamSpiral: PARTICLE_BEAM_SPIRAL,
  particleBeamInputCharge: PARTICLE_BEAM_INPUT_CHARGE,
  particleBeamOutputBurst: PARTICLE_BEAM_OUTPUT_BURST,

  particleUnpair: PARTICLE_UNPAIR_SUCCESS,
  particleBeamUnpair: PARTICLE_UNPAIR_BEAM,

  particleTransferBeam: "chaos:transfer_beam",
  particleTransferItem: "chaos:transfer_orb",
  particleTransferItemByMode: {
    attuned: "chaos:transfer_orb_attuned",
    drift: "chaos:transfer_orb_drift",
    walking: "chaos:transfer_orb_walking",
  },
  particleFluxOrb: "chaos:flux_orb_1",
  particleFluxOrbByTier: [
    "chaos:flux_orb_1",
    "chaos:flux_orb_2",
    "chaos:flux_orb_3",
    "chaos:flux_orb_4",
    "chaos:flux_orb_5",
  ],
  particleExoticOrbById: {
    "chaos:exotic_shard": "chaos:exotic_orb_shard",
    "chaos:exotic_fiber": "chaos:exotic_orb_fiber",
    "chaos:exotic_alloy_lump": "chaos:exotic_orb_alloy_lump",
  },

  // Flux FX (lightweight, optional)
  fluxFxEnabled: true,
  particleFluxGenerate: "chaos:block_burst_pop",
  particleFluxRefine: "chaos:link_input_charge",
  particleFluxMutate: "chaos:link_output_burst",
  particleFluxRefineByTier: [
    "chaos:flux_refine_burst_1",
    "chaos:flux_refine_burst_2",
    "chaos:flux_refine_burst_3",
    "chaos:flux_refine_burst_4",
    "chaos:flux_refine_burst_5",
  ],
  particleFluxMutateById: {
    "chaos:exotic_shard": "chaos:exotic_mutate_burst_shard",
    "chaos:exotic_fiber": "chaos:exotic_mutate_burst_fiber",
    "chaos:exotic_alloy_lump": "chaos:exotic_mutate_burst_alloy_lump",
  },
  burstMixFluxGenerate: [
    { id: "chaos:block_burst_pop", count: 3, radius: 0.22 },
    { id: "chaos:block_burst_puff", count: 2, radius: 0.3 },
    { id: "chaos:link_input_charge", count: 2, radius: 0.18 },
    { id: "chaos:link_output_burst", count: 2, radius: 0.24 },
  ],
  burstMixFluxRefineByTier: [
    [
      { id: "chaos:flux_refine_burst_1", count: 3, radius: 0.26 },
      { id: "chaos:block_burst_puff", count: 2, radius: 0.3 },
    ],
    [
      { id: "chaos:flux_refine_burst_2", count: 3, radius: 0.26 },
      { id: "chaos:block_burst_puff", count: 2, radius: 0.3 },
    ],
    [
      { id: "chaos:flux_refine_burst_3", count: 3, radius: 0.26 },
      { id: "chaos:block_burst_puff", count: 2, radius: 0.3 },
    ],
    [
      { id: "chaos:flux_refine_burst_4", count: 4, radius: 0.28 },
      { id: "chaos:block_burst_puff", count: 2, radius: 0.32 },
    ],
    [
      { id: "chaos:flux_refine_burst_5", count: 4, radius: 0.28 },
      { id: "chaos:block_burst_puff", count: 2, radius: 0.32 },
    ],
  ],
  burstMixFluxMutateById: {
    "chaos:exotic_shard": [
      { id: "chaos:exotic_mutate_burst_shard", count: 3, radius: 0.3 },
      { id: "chaos:link_output_burst", count: 2, radius: 0.22 },
    ],
    "chaos:exotic_fiber": [
      { id: "chaos:exotic_mutate_burst_fiber", count: 3, radius: 0.3 },
      { id: "chaos:link_output_burst", count: 2, radius: 0.22 },
    ],
    "chaos:exotic_alloy_lump": [
      { id: "chaos:exotic_mutate_burst_alloy_lump", count: 3, radius: 0.3 },
      { id: "chaos:link_output_burst", count: 2, radius: 0.22 },
    ],
  },
  sfxFluxMutate: "random.levelup",
  fluxGenerateBurstCount: 3,
  fluxGenerateBurstRadius: 0.2,
  fluxRefineBurstCount: 3,
  fluxRefineBurstRadius: 0.22,
  fluxMutateBurstCount: 4,
  fluxMutateBurstRadius: 0.26,
  fluxMolang: (itemTypeId) => {
    const c = getFluxColor(itemTypeId);
    return makeColorMolang(c.r, c.g, c.b, c.a);
  },

  // Default tinting. Override in presets for vision if needed.
  beamMolang: () => makeColorMolang(0.2, 0.8, 1.0, 1.0),        // link (cyan)
  beamMolangUnpair: () => makeColorMolang(1.0, 0.35, 0.2, 1.0), // unlink (red-orange)
  transferBeamMolang: () => makeColorMolang(1.0, 0.85, 0.2, 1.0), // transfer (gold)
  makeBeamMolang: (dir, dist, speed) => {
    const m = makeColorMolang(0.2, 0.8, 1.0, 1.0);
    applyBeamMotion(m, dir, dist, speed);
    return m;
  },

  // Endpoint burst tuning
  successBurstCount: 10,
  successBurstRadius: 0.6,
  unpairBurstCount: 10,
  unpairBurstRadius: 0.6,

  // Beam FX budgets (per-player unless otherwise noted)
  maxParticlesPerTick: 80,
  linksPerTickBudget: 12,
  fxQueueEnabled: true,
  fxQueueMaxPerTick: 60,
  fxQueueMaxQueued: 800,

  // Link vision culling
  linkVisionDistance: 32,

  // Beam rendering density
  beamStep: 0.9,
  spiralStep: 1.8,
  beamCoreDelayTicks: 2,

  // Motion/shape tuning
  jitterMagnitude: 0.03,
  spiralRadiusMin: 0.05,
  spiralRadiusMax: 0.18,
  pulsePeriodTicks: 20,
  beamFlowLifetimeSeconds: 0.9,

  // Debug: set true to spawn a test core particle near players holding the wand
  debugSpawnBeamParticles: true,
  // Debug: transfer stats in action bar/chat
  debugTransferStats: false,
  debugTransferStatsIntervalTicks: 100,

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
      m.setFloat("variable.chaos_lifetime", ORB_LIFETIME_SECONDS);

      const level = Math.max(getBlockLevel(fromBlock), getBlockLevel(toBlock));
      const color = getOrbColor(level);
      m.setFloat("variable.chaos_color_r", color.r);
      m.setFloat("variable.chaos_color_g", color.g);
      m.setFloat("variable.chaos_color_b", color.b);
      m.setFloat("variable.chaos_color_a", color.a);
      return m;
    } catch {
      return null;
    }
  },
};
