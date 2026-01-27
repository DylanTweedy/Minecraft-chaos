// scripts/chaos/features/logistics/data/crucibleValues.js

// EMC-style flux values for items.
// Populate with every vanilla item + every Chaos item.
// Values are integers; higher = more flux.

export const CRUCIBLE_VALUE_DEFAULT = 1;

// Direct item overrides by id.
// Example:
// "minecraft:diamond": 512,
// "chaos:exotic_shard": 64,
export const CRUCIBLE_VALUE_OVERRIDES = {
  "chaos:flux_1": 1,
  "chaos:flux_2": 3,
  "chaos:flux_3": 7,
  "chaos:flux_4": 15,
  "chaos:flux_5": 30,
  "chaos:exotic_shard": 64,
  "chaos:exotic_fiber": 96,
  "chaos:exotic_alloy_lump": 160,
  "chaos:chaos_crystal_shard": 256,
  "chaos:godsteel_ingot": 512,
  "chaos:prism_1": 128,
  "chaos:prism_2": 256,
  "chaos:prism_3": 512,
  "chaos:prism_4": 1024,
  "chaos:prism_5": 2048,
  "chaos:crucible": 1024,
  "chaos:crystallizer": 2048,
  "chaos:foundry": 4096,
};

// Optional category defaults (future use).
// Example:
// "minecraft:logs": 8,
// "minecraft:planks": 2,
export const CRUCIBLE_VALUE_TAG_DEFAULTS = {
};
