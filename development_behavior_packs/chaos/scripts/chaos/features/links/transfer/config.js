// scripts/chaos/features/links/transfer/config.js
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";

const PRISM_ID = "chaos:prism";
const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";
// Legacy IDs for migration (will be removed eventually)
const INPUT_ID = "chaos:extractor"; // Deprecated - use PRISM_ID
const OUTPUT_ID = "chaos:inserter"; // Deprecated - use PRISM_ID
const FURNACE_BLOCK_IDS = new Set([
  "minecraft:furnace",
  "minecraft:lit_furnace",
  "minecraft:blast_furnace",
  "minecraft:lit_blast_furnace",
  "minecraft:smoker",
  "minecraft:lit_smoker",
]);
const FURNACE_FUEL_FALLBACK_IDS = new Set([
  "minecraft:coal",
  "minecraft:charcoal",
  "minecraft:coal_block",
  "minecraft:blaze_rod",
  "minecraft:lava_bucket",
  "minecraft:stick",
  "minecraft:bamboo",
]);
const FURNACE_SLOTS = {
  input: 0,
  fuel: 1,
  output: 2,
};
const DP_BEAMS = "chaos:beams_v0_json";
const DP_TRANSFERS = "chaos:transfers_v0_json";
const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:prism_levels_v0_json";
const MAX_STEPS = MAX_BEAM_LEN * 12;
const PATH_WEIGHT_MAX_LEN = 6;
const PATH_WEIGHT_LEN_EXP = 0.6;
const PATH_WEIGHT_RANDOM_MIN = 0.5;
const PATH_WEIGHT_RANDOM_MAX = 2.0;
const CRYSTAL_FLUX_WEIGHT = 6.0;
const CRYSTAL_ROUTE_MAX_NODES = 256;
const SPEED_SCALE_MAX = 1.8;
const PRISM_SPEED_BOOST_BASE = 0.0; // Tier 1 has no boost
const PRISM_SPEED_BOOST_PER_TIER = 0.05; // Each tier adds 5% boost (tier 2 = 5%, tier 5 = 20%)

// Prism tier IDs (5 separate blocks, one per tier)
const PRISM_IDS = [
  "chaos:prism_1",
  "chaos:prism_2",
  "chaos:prism_3",
  "chaos:prism_4",
  "chaos:prism_5",
];

// Helper function to check if a block is a prism (any tier)
function isPrismBlock(block) {
  if (!block) return false;
  const typeId = block.typeId || (typeof block === "string" ? block : null);
  if (!typeId) return false;
  return PRISM_IDS.includes(typeId) || typeId === PRISM_ID; // Also support legacy PRISM_ID
}

// Helper to get prism tier from typeId (1-5, or 1 if not a prism)
// Accepts either a block object or a typeId string
function getPrismTierFromTypeId(blockOrTypeId) {
  let typeId;
  if (typeof blockOrTypeId === "string") {
    typeId = blockOrTypeId;
  } else if (blockOrTypeId && blockOrTypeId.typeId) {
    typeId = blockOrTypeId.typeId;
  } else {
    return 1;
  }
  
  const index = PRISM_IDS.indexOf(typeId);
  if (index >= 0) return index + 1; // Return 1-5 based on array index
  if (typeId === PRISM_ID) return 1; // Legacy support
  return 1; // Default tier 1 if not a prism
}

// Helper to get prism typeId for a given tier (1-5)
function getPrismTypeIdForTier(tier) {
  const t = Math.max(1, Math.min(5, Math.floor(tier || 1)));
  return PRISM_IDS[t - 1] || PRISM_IDS[0];
}

const DEFAULTS = {
  maxTransfersPerTick: 4, // Budget for item transfers started per tick
  maxSearchesPerTick: 8, // Budget for pathfinding searches per tick
  perPrismIntervalTicks: 10, // Base interval between prism scans
  cacheTicks: 10,
  cacheTicksWithStamp: 60,
  maxVisitedPerSearch: 200,
  orbStepTicks: 20,
  maxOutputOptions: 6,
  levelStep: 2000, // Massively increased for natural progression
  prismLevelStep: 4000, // Massively increased for natural progression
  maxLevel: 5,
  itemsPerOrbBase: 1,
  itemsPerOrbGrowth: 2,
  maxItemsPerOrb: 64,
  minOrbStepTicks: 1,
  orbVisualMinSpeedScale: 1.0,
  orbVisualMaxSpeedScale: 1.0,
  maxOrbFxPerTick: 160,
  maxQueuedInsertsPerTick: 4,
  maxFullChecksPerTick: 4,
  levelUpBurstCount: 8,
  levelUpBurstRadius: 0.35,
  orbLifetimeScale: 0.5,
  maxPrismsScannedPerTick: 24, // Budget for prisms to scan per tick
  debugTransferStats: true, // Enable debug timing messages
  debugTransferStatsIntervalTicks: 100,
  backoffBaseTicks: 10, // Base backoff when prism finds nothing
  backoffMaxTicks: 200,
  backoffMaxLevel: 6,
  maxFluxFxInFlight: 24,
  inflightSaveIntervalTicks: 40,
  // Legacy - kept for compatibility
  perInputIntervalTicks: 10,
  maxInputsScannedPerTick: 24,
};

export {
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
  PRISM_IDS,
  CRYSTALLIZER_ID,
  BEAM_ID,
  FURNACE_BLOCK_IDS,
  FURNACE_FUEL_FALLBACK_IDS,
  FURNACE_SLOTS,
  DP_BEAMS,
  DP_TRANSFERS,
  DP_INPUT_LEVELS,
  DP_OUTPUT_LEVELS,
  DP_PRISM_LEVELS,
  MAX_BEAM_LEN,
  MAX_STEPS,
  PATH_WEIGHT_MAX_LEN,
  PATH_WEIGHT_LEN_EXP,
  PATH_WEIGHT_RANDOM_MIN,
  PATH_WEIGHT_RANDOM_MAX,
  CRYSTAL_FLUX_WEIGHT,
  CRYSTAL_ROUTE_MAX_NODES,
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,
  isPrismBlock,
  getPrismTierFromTypeId,
  getPrismTypeIdForTier,
  DEFAULTS,
};
