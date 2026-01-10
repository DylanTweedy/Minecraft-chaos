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

// Check if an ID is a pass-through block (air, beam, or any prism)
function isPassThrough(id) {
  if (!id) return false;
  if (id === "minecraft:air" || id === BEAM_ID) return true;
  return PRISM_IDS.includes(id);
}

export {
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
  isPassThrough,
};
