// scripts/chaos/features/links/transfer/runtime/helpers/reasons.js

export const REASONS = Object.freeze({
  OK: "ok",
  QUEUED: "queued",
  ALREADY_QUEUED: "all_items_already_queued",
  NO_PRISM: "no_prism",
  NO_CONTAINER: "no_container",
  NO_PRISM_POS: "no_prism_pos",
  NO_ITEM: "no_item",
  NO_TRANSFER: "no_transfer",
  NO_OPTIONS: "no_options",
  PATHFIND_TIMEOUT: "pathfind_timeout",
  PATHFIND_ERROR: "pathfind_error",
  INVALID_DESTINATION: "invalid_destination",
  INVALID_PATH: "invalid_path",
  SAME_CONTAINER: "same_container",
  FULL: "full",
  NO_CAPACITY: "no_capacity",
  NO_AMOUNT: "no_amount",
  TRANSFER_ERROR: "transfer_error",
  BALANCED: "balanced",
  FILTER_MISMATCH: "filter_mismatch",
  TRANSFER_DISABLED: "transfer_disabled",
});

