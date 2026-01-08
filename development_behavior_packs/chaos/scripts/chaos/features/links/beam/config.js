// scripts/chaos/features/links/beam/config.js
const PRISM_ID = "chaos:prism";
const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";
// Legacy IDs for migration (will be removed eventually)
const INPUT_ID = "chaos:extractor"; // Deprecated - use PRISM_ID
const OUTPUT_ID = "chaos:inserter"; // Deprecated - use PRISM_ID

const INPUTS_PER_TICK = 1;
const RELAYS_PER_TICK = 1;
const VALIDATIONS_PER_TICK = 12;
const TICK_INTERVAL = 1;

const AXIS_X = "x";
const AXIS_Y = "y";
const AXIS_Z = "z";

const DP_BEAMS = "chaos:beams_v0_json";
const EMIT_RETRY_TICKS = 4;

const PASS_THROUGH_IDS = new Set(["minecraft:air", BEAM_ID, PRISM_ID]);

function isPassThrough(id) {
  return PASS_THROUGH_IDS.has(id);
}

export {
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
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
  PASS_THROUGH_IDS,
  isPassThrough,
};
