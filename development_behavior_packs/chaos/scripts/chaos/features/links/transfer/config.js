// scripts/chaos/features/links/transfer/config.js
import { MAX_BEAM_LEN } from "../network/beams/beamConfig.js";

const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";

// Legacy IDs (remove once all imports are gone)
const INPUT_ID = "chaos:extractor"; // Deprecated - replaced by PRISM_IDS
const OUTPUT_ID = "chaos:inserter"; // Deprecated - replaced by PRISM_IDS

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

const DP_TRANSFERS = "chaos:transfers_v0_json";
const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:prism_levels_v0_json";
const DP_PRISMS_V0_JSON = "chaos:prisms_v0_json";
const DP_LINKS_V0_JSON = "chaos:links_v0_json";

// Path / routing
const MAX_STEPS = MAX_BEAM_LEN * 12;
const PATH_WEIGHT_MAX_LEN = 6;
const PATH_WEIGHT_LEN_EXP = 0.6;
const PATH_WEIGHT_RANDOM_MIN = 0.5;
const PATH_WEIGHT_RANDOM_MAX = 2.0;
const CRYSTAL_FLUX_WEIGHT = 6.0;
const CRYSTAL_ROUTE_MAX_NODES = 256;

// Speed / visuals
const SPEED_SCALE_MAX = 1.8;
const PRISM_SPEED_BOOST_BASE = 0.0;
const PRISM_SPEED_BOOST_PER_TIER = 0.05;

// Prism tier IDs (5 separate blocks, one per tier)
const PRISM_IDS = [
  "chaos:prism_1",
  "chaos:prism_2",
  "chaos:prism_3",
  "chaos:prism_4",
  "chaos:prism_5",
];

// O(1) tier lookup
const PRISM_TIER_BY_ID = new Map(PRISM_IDS.map((id, i) => [id, i + 1]));

function clampPrismTier(tier) {
  const t = Number(tier);
  if (!Number.isFinite(t)) return 1;
  return Math.max(1, Math.min(5, Math.floor(t)));
}

/**
 * Preferred: check by id.
 * Use this in most places: isPrismId(block.typeId)
 */
function isPrismId(typeId) {
  return PRISM_TIER_BY_ID.has(typeId);
}

const ENDPOINT_IDS = [
  CRYSTALLIZER_ID,
];

const HYBRID_DRIFT_AMOUNT_BY_TIER = [1, 2, 4, 16, 64];
const HYBRID_DRIFT_INTERVAL_BY_TIER = [20, 15, 10, 7, 5];
const MAX_HYBRID_INFLIGHT_PERSIST_ENTRIES = 50;

function isEndpointId(typeId) {
  return ENDPOINT_IDS.includes(typeId);
}

/**
 * Convenience wrapper when you truly have a block object.
 * Avoid passing strings/objects here; use isPrismId for ids.
 */
function isPrismBlock(block) {
  return !!block && isPrismId(block.typeId);
}

/**
 * Get prism tier from either a block or a typeId string.
 * Returns 1-5 if prism, else 1.
 */
function getPrismTier(blockOrTypeId) {
  const typeId =
    typeof blockOrTypeId === "string"
      ? blockOrTypeId
      : blockOrTypeId?.typeId;

  return PRISM_TIER_BY_ID.get(typeId) || 1;
}

/**
 * Get prism typeId for a given tier (1-5)
 */
function getPrismTypeIdForTier(tier) {
  return PRISM_IDS[clampPrismTier(tier) - 1] || PRISM_IDS[0];
}

const DEFAULTS = {
  maxTransfersPerTick: 4,
  maxSearchesPerTick: 4,

  // Base interval for tier 5 (0.25s) - scales up for lower tiers
  perPrismIntervalTicks: 5,

  cacheTicks: 10,
  cacheTicksWithStamp: 60,

  maxVisitedPerSearch: 120,
  orbStepTicks: 16,

  maxOutputOptions: 4,

  levelStep: 2000,
  prismLevelStep: 4000,
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

  maxPrismsScannedPerTick: 8,
  transferStrategy: "hybrid",
  scanCandidateSlotsPerInventory: 18,
  scanMaxItemTypesPerPrism: 6,
  scanLockTtlTicks: 80,
  scanDriftStickyDestTtlTicks: 40,
  driftMaxTransferAmount: 4,

  debugTransferStats: true,
  debugTransferStatsIntervalTicks: 20,

  backoffBaseTicks: 10,
  backoffMaxTicks: 200,
  backoffMaxLevel: 6,

  maxFluxFxInFlight: 24,
  inflightSaveIntervalTicks: 40,

  useHybridDriftAttune: true,
  hybridMaxOrbsActiveTotal: 400,
  hybridMaxNewTransfersPerTick: 30,
  hybridMaxArrivalsProcessedPerTick: 50,
  hybridMaxPathfindsPerTick: 4,
  hybridDriftSettleBase: 0.05,
  hybridDriftHopGain: 0.02,
  hybridDriftRerouteGain: 0.05,
  hybridDriftMaxChance: 0.95,
  hybridDriftAmountByTier: HYBRID_DRIFT_AMOUNT_BY_TIER,
  hybridDriftIntervalByTier: HYBRID_DRIFT_INTERVAL_BY_TIER,
  hybridAttunedSettleBase: 0.01,
  hybridAttunedHopGain: 0.005,
  hybridAttunedRerouteGain: 0.02,
  hybridAttunedMaxChance: 0.6,
  hybridAttunedSpeedMultiplier: 1.5,
  hybridRerouteCooldownBaseTicks: 10,
  hybridRerouteCooldownStepTicks: 5,
  hybridRerouteCooldownMaxTicks: 60,
  hybridRerouteDropThreshold: 12,
  hybridHopDropThreshold: 40,
  maxHybridInflightPersistEntries: MAX_HYBRID_INFLIGHT_PERSIST_ENTRIES,

  // 50/50 balance distribution settings
  useBalanceDistribution: true,
  balanceMinTransfer: 1,
  balanceCapByLevel: false,

  // Legacy - remove once callers are gone
  perInputIntervalTicks: 10,
  maxInputsScannedPerTick: 8,

  // Prism registry + link graph
  prismSeedScanRadius: 32,
  prismSeedScanBlocksPerTick: 200,
  prismValidationBudgetPerTick: 32,
  linkBuildTicks: 8,
  linkRebuildBudgetPerTick: 8,
  linkValidateBudgetPerTick: 16,

  // Beam visuals + invalidation
  beamBuildBlocksPerTick: 8,
  beamCollapseBlocksPerTick: 8,
  beamBreaksPerTick: 32,
};

export {
  // Legacy (remove later)
  INPUT_ID,
  OUTPUT_ID,

  // Prism ids + helpers
  PRISM_IDS,
  isPrismId,
  isPrismBlock,
  getPrismTier,
  getPrismTypeIdForTier,
  clampPrismTier,

  // IDs
  CRYSTALLIZER_ID,
  BEAM_ID,
  ENDPOINT_IDS,
  isEndpointId,

  // Furnace rules
  FURNACE_BLOCK_IDS,
  FURNACE_FUEL_FALLBACK_IDS,
  FURNACE_SLOTS,

  // Persistence keys
  DP_TRANSFERS,
  DP_INPUT_LEVELS,
  DP_OUTPUT_LEVELS,
  DP_PRISM_LEVELS,
  DP_PRISMS_V0_JSON,
  DP_LINKS_V0_JSON,

  // Shared beam config re-export (optional, but keep for now to avoid churn)
  MAX_BEAM_LEN,

  // Path / routing constants
  MAX_STEPS,
  PATH_WEIGHT_MAX_LEN,
  PATH_WEIGHT_LEN_EXP,
  PATH_WEIGHT_RANDOM_MIN,
  PATH_WEIGHT_RANDOM_MAX,
  CRYSTAL_FLUX_WEIGHT,
  CRYSTAL_ROUTE_MAX_NODES,

  // Speed
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,

  DEFAULTS,
  HYBRID_DRIFT_AMOUNT_BY_TIER,
  HYBRID_DRIFT_INTERVAL_BY_TIER,
  MAX_HYBRID_INFLIGHT_PERSIST_ENTRIES,
};
