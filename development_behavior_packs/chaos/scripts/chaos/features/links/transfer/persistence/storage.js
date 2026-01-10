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
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(inflight);
    const stringifyTime = Date.now() - stringifyStart;
    if (stringifyTime > 50) {
      // Log slow stringify - could indicate large data
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] saveInflight stringify: ${stringifyTime}ms (${inflight.length} entries, ${raw ? raw.length : 0} bytes)`);
            break; // Only send to first player
          }
        }
      } catch {}
    }
    if (typeof raw !== "string") return;
    if (raw.length > 500000) { // 500KB limit
      // Data too large - skip save to prevent watchdog
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] ⚠ saveInflight SKIPPED: Data too large (${raw.length} bytes, ${inflight.length} entries)`);
            break;
          }
        }
      } catch {}
      return;
    }
    const saveStart = Date.now();
    world.setDynamicProperty(DP_TRANSFERS, raw);
    const saveTime = Date.now() - saveStart;
    if (saveTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] saveInflight setDynamicProperty: ${saveTime}ms (${raw.length} bytes)`);
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    // Log errors - they're important
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (player && typeof player.sendMessage === "function") {
          player.sendMessage(`§c[PERF] saveInflight ERROR: ${err?.message || String(err)}`);
          break;
        }
      }
    } catch {}
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
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;
    if (stringifyTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            const keyCount = Object.keys(levels || {}).length;
            player.sendMessage(`§c[PERF] saveInputLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} bytes)`);
            break;
          }
        }
      } catch {}
    }
    if (typeof raw !== "string") return;
    if (raw.length > 500000) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] ⚠ saveInputLevels SKIPPED: Data too large (${raw.length} bytes)`);
            break;
          }
        }
      } catch {}
      return;
    }
    const saveStart = Date.now();
    world.setDynamicProperty(DP_INPUT_LEVELS, raw);
    const saveTime = Date.now() - saveStart;
    if (saveTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] saveInputLevels setDynamicProperty: ${saveTime}ms`);
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (player && typeof player.sendMessage === "function") {
          player.sendMessage(`§c[PERF] saveInputLevels ERROR: ${err?.message || String(err)}`);
          break;
        }
      }
    } catch {}
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
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;
    if (stringifyTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            const keyCount = Object.keys(levels || {}).length;
            player.sendMessage(`§c[PERF] saveOutputLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} bytes)`);
            break;
          }
        }
      } catch {}
    }
    if (typeof raw !== "string") return;
    if (raw.length > 500000) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] ⚠ saveOutputLevels SKIPPED: Data too large (${raw.length} bytes)`);
            break;
          }
        }
      } catch {}
      return;
    }
    const saveStart = Date.now();
    world.setDynamicProperty(DP_OUTPUT_LEVELS, raw);
    const saveTime = Date.now() - saveStart;
    if (saveTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] saveOutputLevels setDynamicProperty: ${saveTime}ms`);
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (player && typeof player.sendMessage === "function") {
          player.sendMessage(`§c[PERF] saveOutputLevels ERROR: ${err?.message || String(err)}`);
          break;
        }
      }
    } catch {}
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
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;
    if (stringifyTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            const keyCount = Object.keys(levels || {}).length;
            player.sendMessage(`§c[PERF] savePrismLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} bytes)`);
            break;
          }
        }
      } catch {}
    }
    if (typeof raw !== "string") return;
    if (raw.length > 500000) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] ⚠ savePrismLevels SKIPPED: Data too large (${raw.length} bytes)`);
            break;
          }
        }
      } catch {}
      return;
    }
    const saveStart = Date.now();
    world.setDynamicProperty(DP_PRISM_LEVELS, raw);
    const saveTime = Date.now() - saveStart;
    if (saveTime > 50) {
      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(`§c[PERF] savePrismLevels setDynamicProperty: ${saveTime}ms`);
            break;
          }
        }
      } catch {}
    }
  } catch (err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (player && typeof player.sendMessage === "function") {
          player.sendMessage(`§c[PERF] savePrismLevels ERROR: ${err?.message || String(err)}`);
          break;
        }
      }
    } catch {}
  }
}
