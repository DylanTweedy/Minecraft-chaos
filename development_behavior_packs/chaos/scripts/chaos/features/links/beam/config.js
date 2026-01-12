// scripts/chaos/features/links/beam/config.js
import { PRISM_IDS } from "../transfer/config.js";

const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";

// Legacy IDs for migration (will be removed eventually)
const INPUT_ID = "chaos:extractor"; // Deprecated - use PRISM_IDS
const OUTPUT_ID = "chaos:inserter"; // Deprecated - use PRISM_IDS

const INPUTS_PER_TICK = 1;
const RELAYS_PER_TICK = 1;
const VALIDATIONS_PER_TICK = 12;
const TICK_INTERVAL = 1;

const AXIS_X = "x";
const AXIS_Y = "y";
const AXIS_Z = "z";

const DP_BEAMS = "chaos:beams_v0_json";
const EMIT_RETRY_TICKS = 4;

/**
 * Prism identity (pure "what is it?" check).
 * Prefer Id-based helpers to keep call sites consistent and avoid passing Block objects into config.
 */
function isPrismId(id) {
  return !!id && PRISM_IDS.includes(id);
}

/**
 * Beam traversal / occupancy check (pure "can the beam ray pass through / exist in this block space?" check).
 * IMPORTANT: This is NOT "isRelay".
 *
 * Today: air + existing beam segments + prisms are pass-through.
 * Later: you can expand this to include dedicated relay blocks or glass, etc.
 */
function isPassThroughId(id) {
  if (!id) return false;
  return id === "minecraft:air" || id === BEAM_ID || isPrismId(id);
}

/**
 * Convenience wrappers (optional) if you prefer passing a Block object in some places.
 * These are thin, safe, and keep encoding issues away from config constants.
 */
function getTypeId(blockOrPermutation) {
  // Supports Block (typeId), or permutation-like objects if you ever pass those.
  return blockOrPermutation?.typeId ?? blockOrPermutation?.type?.id ?? "";
}

function isPrismBlock(block) {
  return isPrismId(getTypeId(block));
}

function isPassThroughBlock(block) {
  return isPassThroughId(getTypeId(block));
}

export {
  // IDs / constants
  INPUT_ID,
  OUTPUT_ID,
  PRISM_IDS,
  CRYSTALLIZER_ID,
  BEAM_ID,
  INPUTS_PER_TICK,
  RELAYS_PER_TICK,
  VALIDATIONS_PER_TICK,
  TICK_INTERVAL,
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  DP_BEAMS,
  EMIT_RETRY_TICKS,

  // Predicates
  isPrismId,
  isPassThroughId,

  // Optional Block-based helpers (use if it makes call sites cleaner)
  isPrismBlock,
  isPassThroughBlock,
};
