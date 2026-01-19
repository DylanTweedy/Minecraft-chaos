// scripts/chaos/features/logistics/persistence/storage.js
import {
  DP_TRANSFERS,
  DP_INPUT_LEVELS,
  DP_OUTPUT_LEVELS,
  DP_PRISM_LEVELS,
  DP_PRISMS_V0_JSON,
  DP_LINKS_V0_JSON,
  MAX_HYBRID_INFLIGHT_PERSIST_ENTRIES,
} from "../config.js";
import { emitTrace } from "../../../core/insight/trace.js";

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return null;
  }
}

// Bedrock dynamic properties for strings have a hard cap.
const DYNAMIC_PROPERTY_MAX_LENGTH = 32767;

function isHybridJob(job) {
  if (!job || typeof job !== "object") return false;
  const mode = job.mode;
  return typeof mode === "string" && mode.startsWith("hybrid");
}

function buildHybridJobEntry(job) {
  if (!job || typeof job !== "object") return null;

  const entry = {
    id: job.id,
    mode: job.mode,
    itemTypeId: job.itemTypeId,
    amount: job.amount,
    dimId: job.dimId,

    sourcePrismKey: job.sourcePrismKey,
    currentPrismKey: job.currentPrismKey,
    destPrismKey: job.destPrismKey,
    prevPrismKey: job.prevPrismKey,

    stepIndex: job.stepIndex,
    ticksUntilStep: job.ticksUntilStep,
    stepTicks: job.stepTicks,
    cooldownTicks: job.cooldownTicks,

    hops: job.hops,
    reroutes: job.reroutes,

    startTick: job.startTick,
    createdTick: job.createdTick,
  };

  if (job.startPos) entry.startPos = job.startPos;
  if (job.prismKey) entry.prismKey = job.prismKey;
  if (job.containerKey) entry.containerKey = job.containerKey;
  if (job.outputKey) entry.outputKey = job.outputKey;
  if (job.refineOnPrism) entry.refineOnPrism = job.refineOnPrism;
  if (job.speedScale != null) entry.speedScale = job.speedScale;

  return entry;
}

function buildInflightPayload(inflight, limit) {
  const entries = [];
  if (!Array.isArray(inflight) || limit <= 0) {
    return { entries, trimmedCount: 0 };
  }

  for (let i = 0; i < inflight.length && entries.length < limit; i++) {
    const job = inflight[i];
    if (!job) continue;

    // Hybrid jobs are trimmed to a stable/minimal shape.
    const entry = isHybridJob(job) ? buildHybridJobEntry(job) : job;
    if (!entry) continue;

    entries.push(entry);
  }

  return {
    entries,
    trimmedCount: Math.max(0, inflight.length - entries.length),
  };
}

function tryStringify(v) {
  const start = Date.now();
  const raw = safeJsonStringify(v);
  return { raw, duration: Date.now() - start };
}

function perfPing(world, message) {
  try {
    const players = world.getAllPlayers?.() || [];
    for (const p of players) {
      if (p && typeof p.sendMessage === "function") {
        p.sendMessage(message);
        break;
      }
    }
  } catch (e) {
    // ignore
  }
}

export function loadPrismRegistry(world) {
  try {
    const raw = world.getDynamicProperty(DP_PRISMS_V0_JSON);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const list = Array.isArray(parsed) ? parsed : parsed.list;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function savePrismRegistry(world, list) {
  try {
    const raw = safeJsonStringify(Array.isArray(list) ? list : []);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_PRISMS_V0_JSON, raw);
  } catch (e) {
    // ignore
  }
}

export function loadLinkGraph(world) {
  try {
    const raw = world.getDynamicProperty(DP_LINKS_V0_JSON);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const list = Array.isArray(parsed) ? parsed : parsed.list;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function saveLinkGraph(world, list) {
  try {
    const raw = safeJsonStringify(Array.isArray(list) ? list : []);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_LINKS_V0_JSON, raw);
  } catch (e) {
    // ignore
  }
}

export function loadInflight(world) {
  try {
    const raw = world.getDynamicProperty(DP_TRANSFERS);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    return [];
  }
}

export function saveInflight(world, inflight) {
  try {
    const limit = Math.max(1, MAX_HYBRID_INFLIGHT_PERSIST_ENTRIES | 0);
    const payload = buildInflightPayload(inflight, limit);

    if (payload.trimmedCount > 0) {
      emitTrace?.(null, "hybrid", {
        text: `Hybrid inflight trimmed to ${payload.entries.length} entries before persistence (dropped ${payload.trimmedCount})`,
        category: "hybrid",
        dedupeKey: "hybrid_inflight_trim_limit",
      });
    }

    let { raw, duration } = tryStringify(payload.entries);
    let stringifyTime = duration;

    // If we still exceed the DP size limit, keep trimming until we fit.
    let trimmedForSize = 0;
    while (raw && raw.length > DYNAMIC_PROPERTY_MAX_LENGTH && payload.entries.length > 0) {
      payload.entries.pop();
      trimmedForSize++;

      const next = tryStringify(payload.entries);
      raw = next.raw;
      stringifyTime += next.duration;
    }

    if (!raw || raw.length > DYNAMIC_PROPERTY_MAX_LENGTH) {
      emitTrace?.(null, "hybrid", {
        text: `Hybrid inflight save SKIPPED: dynamic property limit (${DYNAMIC_PROPERTY_MAX_LENGTH} chars) exceeded`,
        category: "hybrid",
        dedupeKey: "hybrid_inflight_dp_limit",
      });
      return;
    }

    if (trimmedForSize > 0) {
      emitTrace?.(null, "hybrid", {
        text: `Hybrid inflight trimmed another ${trimmedForSize} entries to stay under ${DYNAMIC_PROPERTY_MAX_LENGTH} chars`,
        category: "hybrid",
        dedupeKey: "hybrid_inflight_dp_trim",
      });
    }

    if (stringifyTime > 50) {
      perfPing(
        world,
        `§c[PERF] saveInflight stringify: ${stringifyTime}ms (${payload.entries.length} persisted, ${Array.isArray(inflight) ? inflight.length : 0} tracked, ${raw.length} chars)`
      );
    }

    const saveStart = Date.now();
    world.setDynamicProperty(DP_TRANSFERS, raw);
    const saveTime = Date.now() - saveStart;

    if (saveTime > 50) {
      perfPing(world, `§c[PERF] saveInflight setDynamicProperty: ${saveTime}ms (${raw.length} chars)`);
    }
  } catch (err) {
    perfPing(world, `§c[PERF] saveInflight ERROR: ${err?.message || String(err)}`);
  }
}

export function loadInputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_INPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    return {};
  }
}

export function saveInputLevels(world, levels) {
  try {
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;

    if (stringifyTime > 50) {
      const keyCount = Object.keys(levels || {}).length;
      perfPing(world, `§c[PERF] saveInputLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} chars)`);
    }

    if (typeof raw !== "string") return;

    // NOTE: Levels can get big; don't melt the DP system.
    if (raw.length > 500000) {
      perfPing(world, `§c[PERF] ⚠ saveInputLevels SKIPPED: Data too large (${raw.length} chars)`);
      return;
    }

    const saveStart = Date.now();
    world.setDynamicProperty(DP_INPUT_LEVELS, raw);
    const saveTime = Date.now() - saveStart;

    if (saveTime > 50) {
      perfPing(world, `§c[PERF] saveInputLevels setDynamicProperty: ${saveTime}ms`);
    }
  } catch (err) {
    perfPing(world, `§c[PERF] saveInputLevels ERROR: ${err?.message || String(err)}`);
  }
}

export function loadOutputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_OUTPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    return {};
  }
}

export function saveOutputLevels(world, levels) {
  try {
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;

    if (stringifyTime > 50) {
      const keyCount = Object.keys(levels || {}).length;
      perfPing(world, `§c[PERF] saveOutputLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} chars)`);
    }

    if (typeof raw !== "string") return;

    if (raw.length > 500000) {
      perfPing(world, `§c[PERF] ⚠ saveOutputLevels SKIPPED: Data too large (${raw.length} chars)`);
      return;
    }

    const saveStart = Date.now();
    world.setDynamicProperty(DP_OUTPUT_LEVELS, raw);
    const saveTime = Date.now() - saveStart;

    if (saveTime > 50) {
      perfPing(world, `§c[PERF] saveOutputLevels setDynamicProperty: ${saveTime}ms`);
    }
  } catch (err) {
    perfPing(world, `§c[PERF] saveOutputLevels ERROR: ${err?.message || String(err)}`);
  }
}

export function loadPrismLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_PRISM_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (e) {
    return {};
  }
}

export function savePrismLevels(world, levels) {
  try {
    const stringifyStart = Date.now();
    const raw = safeJsonStringify(levels);
    const stringifyTime = Date.now() - stringifyStart;

    if (stringifyTime > 50) {
      const keyCount = Object.keys(levels || {}).length;
      perfPing(world, `§c[PERF] savePrismLevels stringify: ${stringifyTime}ms (${keyCount} keys, ${raw ? raw.length : 0} chars)`);
    }

    if (typeof raw !== "string") return;

    if (raw.length > 500000) {
      perfPing(world, `§c[PERF] ⚠ savePrismLevels SKIPPED: Data too large (${raw.length} chars)`);
      return;
    }

    const saveStart = Date.now();
    world.setDynamicProperty(DP_PRISM_LEVELS, raw);
    const saveTime = Date.now() - saveStart;

    if (saveTime > 50) {
      perfPing(world, `§c[PERF] savePrismLevels setDynamicProperty: ${saveTime}ms`);
    }
  } catch (err) {
    perfPing(world, `§c[PERF] savePrismLevels ERROR: ${err?.message || String(err)}`);
  }
}


