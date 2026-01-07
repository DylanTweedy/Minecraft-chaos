// scripts/chaos/features/links/transfer/config.js
import { MAX_BEAM_LEN } from "../shared/beamConfig.js";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const PRISM_ID = "chaos:prism";
const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";
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
const PRISM_SPEED_BOOST_BASE = 1.0;
const PRISM_SPEED_BOOST_PER_TIER = 0.08;

const DEFAULTS = {
  maxTransfersPerTick: 4,
  perInputIntervalTicks: 10,
  cacheTicks: 10,
  cacheTicksWithStamp: 60,
  maxVisitedPerSearch: 200,
  orbStepTicks: 20,
  maxOutputOptions: 6,
  levelStep: 200,
  prismLevelStep: 400,
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
  maxInputsScannedPerTick: 24,
  debugTransferStats: false,
  debugTransferStatsIntervalTicks: 100,
  backoffBaseTicks: 10,
  backoffMaxTicks: 200,
  backoffMaxLevel: 6,
  maxFluxFxInFlight: 24,
  inflightSaveIntervalTicks: 40,
};

export {
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
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
  DEFAULTS,
};
