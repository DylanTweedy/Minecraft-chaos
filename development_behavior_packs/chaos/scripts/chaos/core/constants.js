// scripts/chaos/constants.js

export const MOD = "Chaos";

// Pairing / pending
export const PENDING_TIMEOUT_TICKS = 20 * 60; // 60s at 20 TPS

// Dynamic Properties (chunked storage)
export const DP_PAIRS_COUNT = "chaos:pairs_count";
export const DP_PAIRS_CHUNK_PREFIX = "chaos:pairs_chunk_";

// Tune these if you like
export const DP_PAIRS_MAX_CHUNKS = 8;      // supports fairly big networks
export const DP_PAIRS_CHUNK_SIZE = 14000;  // keep chunks comfortably sized

// Teleporter pairs (chunked)
export const DP_TP_PAIRS_COUNT = "chaos:tp_pairs_count";
export const DP_TP_PAIRS_CHUNK_PREFIX = "chaos:tp_pairs_chunk_";
export const DP_TP_PAIRS_MAX_CHUNKS = 6;
export const DP_TP_PAIRS_CHUNK_SIZE = 12000;

// Vacuum hopper registry
export const DP_VACUUM_HOPPERS = "chaos:vacuum_hoppers_v1_json";
export const DP_VACUUM_HOPPER_BUFFERS = "chaos:vacuum_hopper_buffers_v1_json";

// Sounds (vanilla)
export const SFX_SELECT_INPUT = "random.click";
export const SFX_PAIR_SUCCESS = "random.levelup";
export const SFX_UNPAIR = "random.anvil_land";

// Particles
export const PARTICLE_SELECT_INPUT = "minecraft:basic_flame_particle";
export const PARTICLE_PAIR_SUCCESS = "chaos:block_burst_pop";
export const PARTICLE_BEAM = "chaos:link_beam";

// Upgraded beam visuals
export const PARTICLE_BEAM_CORE = "chaos:link_beam_core";
export const PARTICLE_BEAM_HAZE = "chaos:link_beam_haze";
export const PARTICLE_BEAM_SPIRAL = "chaos:link_beam_spiral";
export const PARTICLE_BEAM_INPUT_CHARGE = "chaos:link_input_charge";
export const PARTICLE_BEAM_OUTPUT_BURST = "chaos:link_output_burst";

// Unpair visuals
export const PARTICLE_UNPAIR_SUCCESS = "chaos:block_burst_puff";
export const PARTICLE_UNPAIR_BEAM = "chaos:link_beam";
