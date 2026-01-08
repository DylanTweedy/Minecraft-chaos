// scripts/chaos/features/links/transfer/persistence/storage.js
import {
  DP_BEAMS,
  DP_TRANSFERS,
  DP_INPUT_LEVELS,
  DP_OUTPUT_LEVELS,
  DP_PRISM_LEVELS,
} from "../config.js";

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

export function loadBeamsMap(world) {
  try {
    const raw = world.getDynamicProperty(DP_BEAMS);
    if (typeof raw !== "string") return {};
    
    // Check if raw data looks truncated (common sign: ends mid-JSON)
    const isTruncated = raw.length > 0 && !raw.trim().endsWith("}") && !raw.trim().endsWith("]");
    
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") {
      // If we have raw data but parsing failed, it might be truncated
      if (raw.length > 1000 && isTruncated) {
        // Log warning - but we can't use console in Bedrock, so return empty
        // The controller will detect this via size checks
      }
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveBeamsMap(world, map) {
  try {
    const raw = safeJsonStringify(map);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_BEAMS, raw);
  } catch {
    // ignore
  }
}

export function loadInflight(world) {
  try {
    const raw = world.getDynamicProperty(DP_TRANSFERS);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function saveInflight(world, inflight) {
  try {
    const raw = safeJsonStringify(inflight);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_TRANSFERS, raw);
  } catch {
    // ignore
  }
}

export function loadInputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_INPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveInputLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_INPUT_LEVELS, raw);
  } catch {
    // ignore
  }
}

export function loadOutputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_OUTPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveOutputLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_OUTPUT_LEVELS, raw);
  } catch {
    // ignore
  }
}

export function loadPrismLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_PRISM_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function savePrismLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_PRISM_LEVELS, raw);
  } catch {
    // ignore
  }
}
