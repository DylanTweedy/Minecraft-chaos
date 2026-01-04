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

// Sounds (vanilla)
export const SFX_SELECT_INPUT = "random.click";
export const SFX_PAIR_SUCCESS = "random.levelup";
export const SFX_UNPAIR = "random.anvil_land";

// Particles
export const PARTICLE_SELECT_INPUT = "minecraft:basic_flame_particle";
export const PARTICLE_PAIR_SUCCESS = "chaos:block_burst_pop";
export const PARTICLE_BEAM = "chaos:link_beam";

// Unpair visuals
export const PARTICLE_UNPAIR_SUCCESS = "chaos:block_burst_puff";
export const PARTICLE_UNPAIR_BEAM = "chaos:link_beam";
