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

// Particles (vanilla)
export const PARTICLE_SELECT_INPUT = "minecraft:basic_flame_particle";
export const PARTICLE_PAIR_SUCCESS = "minecraft:basic_flame_particle";
export const PARTICLE_BEAM = "minecraft:basic_flame_particle";

// NEW: Unpair visuals (safe defaults; swap later if you like)
export const PARTICLE_UNPAIR_SUCCESS = "minecraft:basic_smoke_particle";
export const PARTICLE_UNPAIR_BEAM = "minecraft:basic_smoke_particle";
