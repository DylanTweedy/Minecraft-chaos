// scripts/chaos/features/links/transferSystem.js
// Network transfer system using beam graph pathing.

import { ItemStack, MolangVariableMap } from "@minecraft/server";
import { MAX_BEAM_LEN } from "./beamConfig.js";
import { getFilterSetForBlock } from "./filters.js";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const PRISM_ID = "chaos:prism";
const BEAM_ID = "chaos:beam";
const DP_BEAMS = "chaos:beams_v0_json";
const DP_TRANSFERS = "chaos:transfers_v0_json";
const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:prism_levels_v0_json";
const MAX_STEPS = MAX_BEAM_LEN * 12;
const PATH_WEIGHT_MAX_LEN = 6;
const PATH_WEIGHT_RANDOM_MIN = 0.4;
const PATH_WEIGHT_RANDOM_MAX = 1.6;

const DEFAULTS = {
  maxTransfersPerTick: 4,
  perInputIntervalTicks: 10,
  cacheTicks: 10,
  cacheTicksWithStamp: 60,
  maxVisitedPerSearch: 200,
  orbStepTicks: 20,
  maxOutputOptions: 6,
  levelStep: 100,
  maxLevel: 5,
  itemsPerOrbBase: 1,
  itemsPerOrbGrowth: 2,
  maxItemsPerOrb: 64,
  minOrbStepTicks: 1,
  orbVisualMinSpeedScale: 1.0,
  orbVisualMaxSpeedScale: 1.0,
  maxQueuedInsertsPerTick: 4,
  maxFullChecksPerTick: 4,
  levelUpBurstCount: 8,
  levelUpBurstRadius: 0.35,
  orbLifetimeScale: 0.5,
  maxInputsScannedPerTick: 24,
  debugTransferStats: false,
  debugTransferStatsIntervalTicks: 100,
  debugTransferStatsActionBar: true,
  backoffBaseTicks: 10,
  backoffMaxTicks: 200,
  backoffMaxLevel: 6,
};

const reservedByContainer = new Map();

function mergeCfg(defaults, opts) {
  const cfg = {};
  for (const k in defaults) cfg[k] = defaults[k];
  if (opts) {
    for (const k2 in opts) cfg[k2] = opts[k2];
  }
  return cfg;
}

function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

function getContainerKey(block) {
  try {
    if (!block) return null;
    const loc = block.location;
    return key(block.dimension.id, loc.x, loc.y, loc.z);
  } catch {
    return null;
  }
}

function parseKey(k) {
  try {
    if (typeof k !== "string") return null;
    const p = k.indexOf("|");
    if (p <= 0) return null;
    const dimId = k.slice(0, p);
    const rest = k.slice(p + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { dimId, x: x | 0, y: y | 0, z: z | 0 };
  } catch {
    return null;
  }
}

function resolveBlockInfoStatic(world, blockKey) {
  try {
    const pos = parseKey(blockKey);
    if (!pos) return null;
    const dim = world.getDimension(pos.dimId);
    if (!dim) return null;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;
    return { dim, block, pos };
  } catch {
    return null;
  }
}

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

function loadBeamsMap(world) {
  try {
    const raw = world.getDynamicProperty(DP_BEAMS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function loadInflight(world) {
  try {
    const raw = world.getDynamicProperty(DP_TRANSFERS);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveInflight(world, inflight) {
  try {
    const raw = safeJsonStringify(inflight);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_TRANSFERS, raw);
  } catch {
    // ignore
  }
}

function loadInputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_INPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveInputLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_INPUT_LEVELS, raw);
  } catch {
    // ignore
  }
}

function loadOutputLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_OUTPUT_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveOutputLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_OUTPUT_LEVELS, raw);
  } catch {
    // ignore
  }
}

function loadPrismLevels(world) {
  try {
    const raw = world.getDynamicProperty(DP_PRISM_LEVELS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function savePrismLevels(world, levels) {
  try {
    const raw = safeJsonStringify(levels);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_PRISM_LEVELS, raw);
  } catch {
    // ignore
  }
}

function getNodeType(id) {
  if (id === INPUT_ID) return "input";
  if (id === OUTPUT_ID) return "output";
  if (id === PRISM_ID) return "prism";
  return null;
}

function allowAdjacentNode(curType, nodeType) {
  if (curType === "prism" || nodeType === "prism") return true;
  if (nodeType === "output") return true;
  if (nodeType === "input") return true;
  return false;
}

function scanEdgeFromNode(dim, loc, dir, curNodeType) {
  const path = [];
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dir.dx * i;
    const y = loc.y + dir.dy * i;
    const z = loc.z + dir.dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === BEAM_ID) {
      path.push({ x, y, z });
      continue;
    }

    const nodeType = getNodeType(id);
    if (nodeType) {
      if (path.length === 0 && !allowAdjacentNode(curNodeType, nodeType)) return null;
      return {
        nodeType,
        nodePos: { x, y, z },
        path: path,
      };
    }

    break;
  }
  return null;
}

function makeDirs() {
  return [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
}

export function createTransferPathfinder(deps, opts) {
  const world = deps.world;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);
  const cache = new Map();
  const stats = {
    searches: 0,
    visitedTotal: 0,
    visitedMax: 0,
    outputsTotal: 0,
    outputsMax: 0,
  };

  function invalidateInput(inputKey) {
    cache.delete(inputKey);
  }

  function findPathForInput(inputKey, nowTick) {
    const stamp = (typeof getNetworkStamp === "function") ? getNetworkStamp() : null;
    const cached = cache.get(inputKey);
    if (cached) {
      const ttl = (stamp == null || stamp !== cached.stamp)
        ? cfg.cacheTicks
        : Math.max(cfg.cacheTicks, cfg.cacheTicksWithStamp);
      const okTick = (nowTick - cached.tick) <= ttl;
      const okStamp = (stamp == null || stamp === cached.stamp);
      if (okTick && okStamp) return cached.outputs;
    }

    const parsed = parseKey(inputKey);
    if (!parsed) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const dim = world.getDimension(parsed.dimId);
    if (!dim) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const startBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!startBlock || startBlock.typeId !== INPUT_ID) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
      return null;
    }

    const visited = new Set();
    let visitedCount = 0;
    const queue = [];
    let qIndex = 0;
    queue.push({
      nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
      nodeType: "input",
      path: [],
    });
    visited.add(key(parsed.dimId, parsed.x, parsed.y, parsed.z));
    visitedCount++;

    const dirs = makeDirs();
    const outputs = [];
    while (qIndex < queue.length) {
      if (visitedCount >= cfg.maxVisitedPerSearch) break;
      const cur = queue[qIndex++];
      if (!cur) continue;

      for (const d of dirs) {
        const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
        if (!edge) continue;

        const nextKey = key(parsed.dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
        if (visited.has(nextKey)) continue;

        const nextPath = cur.path.concat(edge.path, [edge.nodePos]);

        if (edge.nodeType === "output") {
          outputs.push({
            dimId: parsed.dimId,
            outputKey: nextKey,
            outputPos: edge.nodePos,
            path: nextPath,
          });
          if (outputs.length >= cfg.maxOutputOptions) {
            visited.add(nextKey);
            visitedCount++;
            queue.push({
              nodePos: edge.nodePos,
              nodeType: edge.nodeType,
              path: nextPath,
            });
            break;
          }
        }

        visited.add(nextKey);
        visitedCount++;
        queue.push({
          nodePos: edge.nodePos,
          nodeType: edge.nodeType,
          path: nextPath,
        });
        if (visitedCount >= cfg.maxVisitedPerSearch) break;
      }
      if (outputs.length >= cfg.maxOutputOptions) break;
    }

    stats.searches++;
    stats.visitedTotal += visitedCount;
    stats.visitedMax = Math.max(stats.visitedMax, visitedCount);
    stats.outputsTotal += outputs.length;
    stats.outputsMax = Math.max(stats.outputsMax, outputs.length);

    if (outputs.length > 0) {
      cache.set(inputKey, { tick: nowTick, stamp, outputs });
      return outputs;
    }

    cache.set(inputKey, { tick: nowTick, stamp, outputs: null });
    return null;
  }

  function getAndResetStats() {
    const snapshot = {
      searches: stats.searches,
      visitedTotal: stats.visitedTotal,
      visitedMax: stats.visitedMax,
      outputsTotal: stats.outputsTotal,
      outputsMax: stats.outputsMax,
    };
    stats.searches = 0;
    stats.visitedTotal = 0;
    stats.visitedMax = 0;
    stats.outputsTotal = 0;
    stats.outputsMax = 0;
    return snapshot;
  }

  return { findPathForInput, invalidateInput, getAndResetStats };
}

export function createNetworkTransferController(deps, opts) {
  const world = deps.world;
  const system = deps.system;
  const FX = deps.FX;
  const getSpeedForInput = deps.getSpeedForInput;
  const findPathForInput = deps.findPathForInput;
  const invalidateInput = deps.invalidateInput;
  const getPathStats = deps.getPathStats;

  const cfg = mergeCfg(DEFAULTS, opts);

  let cursor = 0;
  let tickId = null;
  let nowTick = 0;

  const nextAllowed = new Map();
  const inflight = [];
  let inflightDirty = false;
  let lastSaveTick = 0;
  const transferCounts = new Map();
  let levelsDirty = false;
  let lastLevelsSaveTick = 0;
  const outputCounts = new Map();
  let outputLevelsDirty = false;
  let lastOutputLevelsSaveTick = 0;
  const prismCounts = new Map();
  let prismLevelsDirty = false;
  let lastPrismLevelsSaveTick = 0;
  const queueByContainer = new Map();
  const fullContainers = new Set();
  let fullCursor = 0;
  let queueCursor = 0;
  const inputBackoff = new Map();
  const debugEnabled = !!(cfg.debugTransferStats || FX?.debugTransferStats);
  const debugInterval = Math.max(20, Number(cfg.debugTransferStatsIntervalTicks || FX?.debugTransferStatsIntervalTicks) || 100);
  const debugUseActionBar = (cfg.debugTransferStatsActionBar != null)
    ? !!cfg.debugTransferStatsActionBar
    : !!FX?.debugTransferStatsActionBar;
  let lastDebugTick = 0;
  const debugState = {
    inputsScanned: 0,
    transfersStarted: 0,
    outputOptionsTotal: 0,
    outputOptionsMax: 0,
  };

  function getBackoffTicks(level) {
    const safeLevel = Math.max(0, level | 0);
    const base = Math.max(0, cfg.backoffBaseTicks | 0);
    if (safeLevel <= 0 || base <= 0) return 0;
    const maxTicks = Math.max(base, cfg.backoffMaxTicks | 0);
    const scaled = base * Math.pow(2, Math.max(0, safeLevel - 1));
    return Math.min(maxTicks, Math.floor(scaled));
  }

  function bumpBackoff(inputKey) {
    if (!inputKey) return 0;
    const prev = inputBackoff.get(inputKey) || 0;
    const maxLevel = Math.max(0, cfg.backoffMaxLevel | 0);
    const next = Math.min(maxLevel, prev + 1);
    inputBackoff.set(inputKey, next);
    return next;
  }

  function clearBackoff(inputKey) {
    if (!inputKey) return;
    inputBackoff.delete(inputKey);
  }

  function resetDebugState() {
    debugState.inputsScanned = 0;
    debugState.transfersStarted = 0;
    debugState.outputOptionsTotal = 0;
    debugState.outputOptionsMax = 0;
  }

  function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}
    const level = (block?.permutation?.getState("chaos:level") | 0) || 1;
    const scale = Math.pow(2, Math.max(0, level - 1));
    const interval = Math.max(1, Math.floor(cfg.perInputIntervalTicks / scale));
    return { intervalTicks: interval, amount: 1 };
  }

  function start() {
    if (tickId !== null) return;
    loadInflightState();
    loadLevelsState();
    loadOutputLevelsState();
    loadPrismLevelsState();
    tickId = system.runInterval(onTick, 1);
  }

  function stop() {
    if (tickId === null) return;
    try { system.clearRun(tickId); } catch (_) {}
    tickId = null;
  }

  function loadInflightState() {
    loadInflightStateFromWorld(world, inflight, cfg);
    rebuildReservationsFromInflight();
    inflightDirty = false;
    lastSaveTick = nowTick;
  }

  function persistInflightIfNeeded() {
    if (!inflightDirty && (inflight.length === 0 || (nowTick - lastSaveTick) < 10)) return;
    persistInflightStateToWorld(world, inflight);
    inflightDirty = false;
    lastSaveTick = nowTick;
  }

  function loadLevelsState() {
    const raw = loadInputLevels(world);
    transferCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      transferCounts.set(k, n | 0);
    }
    levelsDirty = false;
    lastLevelsSaveTick = nowTick;
  }

  function persistLevelsIfNeeded() {
    if (!levelsDirty && (nowTick - lastLevelsSaveTick) < 200) return;
    const obj = {};
    for (const [k, v] of transferCounts.entries()) obj[k] = v;
    saveInputLevels(world, obj);
    levelsDirty = false;
    lastLevelsSaveTick = nowTick;
  }

  function loadOutputLevelsState() {
    const raw = loadOutputLevels(world);
    outputCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      outputCounts.set(k, n | 0);
    }
    outputLevelsDirty = false;
    lastOutputLevelsSaveTick = nowTick;
  }

  function persistOutputLevelsIfNeeded() {
    if (!outputLevelsDirty && (nowTick - lastOutputLevelsSaveTick) < 200) return;
    const obj = {};
    for (const [k, v] of outputCounts.entries()) obj[k] = v;
    saveOutputLevels(world, obj);
    outputLevelsDirty = false;
    lastOutputLevelsSaveTick = nowTick;
  }

  function loadPrismLevelsState() {
    const raw = loadPrismLevels(world);
    prismCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      prismCounts.set(k, n | 0);
    }
    prismLevelsDirty = false;
    lastPrismLevelsSaveTick = nowTick;
  }

  function persistPrismLevelsIfNeeded() {
    if (!prismLevelsDirty && (nowTick - lastPrismLevelsSaveTick) < 200) return;
    const obj = {};
    for (const [k, v] of prismCounts.entries()) obj[k] = v;
    savePrismLevels(world, obj);
    prismLevelsDirty = false;
    lastPrismLevelsSaveTick = nowTick;
  }

  function enqueuePendingForContainer(containerKey, itemTypeId, amount, outputKey) {
    if (!containerKey || !itemTypeId || amount <= 0) return;
    let queue = queueByContainer.get(containerKey);
    if (!queue) {
      queue = [];
      queueByContainer.set(containerKey, queue);
    }
    queue.push({ itemTypeId, amount, outputKey });
    fullContainers.add(containerKey);
  }

  function resolveContainerInfo(containerKey) {
    const pos = parseKey(containerKey);
    if (!pos) return null;
    const dim = world.getDimension(pos.dimId);
    if (!dim) return null;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;
    const container = getInventoryContainer(block);
    if (!container) return null;
    return { dim, block, container, pos };
  }

  function getContainerCapacityWithReservations(containerKey, container) {
    try {
      if (!containerKey || !container) return 0;
      const size = container.size;
      let stackRoom = 0;
      let emptySlots = 0;

      for (let i = 0; i < size; i++) {
        const it = container.getItem(i);
        if (!it) {
          emptySlots++;
          continue;
        }
        const max = it.maxAmount || 64;
        if (it.amount < max) stackRoom += (max - it.amount);
      }

      const reservedTotal = getReservedForContainer(containerKey).total;
      const capacity = stackRoom + (emptySlots * 64);
      return Math.max(0, capacity - reservedTotal);
    } catch (_) {
      return 0;
    }
  }

  function tickOutputQueues() {
    let budget = Math.max(0, cfg.maxQueuedInsertsPerTick | 0);
    if (budget <= 0 || queueByContainer.size === 0) return;

    const keys = Array.from(queueByContainer.keys());
    while (budget > 0 && keys.length > 0) {
      if (queueCursor >= keys.length) queueCursor = 0;
      const containerKey = keys[queueCursor++];
      const queue = queueByContainer.get(containerKey);
      if (!queue || queue.length === 0) {
        queueByContainer.delete(containerKey);
        fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        while (queue.length > 0) {
          const job = queue.shift();
          const outInfo = job?.outputKey ? resolveBlockInfo(job.outputKey) : null;
          if (outInfo?.dim && outInfo?.block) {
            dropItemAt(outInfo.dim, outInfo.block.location, job.itemTypeId, job.amount);
          } else if (info?.dim) {
            dropItemAt(info.dim, info.pos, job.itemTypeId, job.amount);
          }
          releaseContainerSlot(containerKey, job.itemTypeId, job.amount);
        }
        queueByContainer.delete(containerKey);
        fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const job = queue[0];
      if (!job) {
        queue.shift();
        budget--;
        continue;
      }

      if (tryInsertAmount(info.container, job.itemTypeId, job.amount)) {
        queue.shift();
        releaseContainerSlot(containerKey, job.itemTypeId, job.amount);
        const outInfo = job.outputKey ? resolveBlockInfo(job.outputKey) : null;
        if (outInfo?.block && outInfo.block.typeId === OUTPUT_ID) {
          noteOutputTransfer(job.outputKey, outInfo.block);
        }
        if (queue.length === 0) {
          queueByContainer.delete(containerKey);
          fullContainers.delete(containerKey);
        }
      } else {
        fullContainers.add(containerKey);
      }
      budget--;
    }
  }

  function tickFullContainers() {
    const total = fullContainers.size;
    if (total === 0) return;
    let budget = Math.max(0, cfg.maxFullChecksPerTick | 0);
    if (budget <= 0) return;

    const keys = Array.from(fullContainers);
    while (budget-- > 0 && keys.length > 0) {
      if (fullCursor >= keys.length) fullCursor = 0;
      const containerKey = keys[fullCursor++];
      if (queueByContainer.has(containerKey)) continue;

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        fullContainers.delete(containerKey);
        continue;
      }
      const capacity = getContainerCapacityWithReservations(containerKey, info.container);
      if (capacity > 0) fullContainers.delete(containerKey);
    }
  }

  function onTick() {
    nowTick++;

    tickOutputQueues();
    tickFullContainers();
    tickInFlight();

    const map = loadBeamsMap(world);
    const inputKeys = Object.keys(map);
    if (inputKeys.length === 0) return;

    if (cursor >= inputKeys.length) cursor = 0;
    let scanned = 0;
    let budget = cfg.maxTransfersPerTick;
    let transfersThisTick = 0;
    const scanLimit = Math.min(
      inputKeys.length,
      Math.max(1, cfg.maxInputsScannedPerTick | 0)
    );

    while (budget > 0 && scanned < scanLimit) {
      const inputKey = inputKeys[cursor];
      cursor = (cursor + 1) % inputKeys.length;
      scanned++;

      const allowedAt = nextAllowed.has(inputKey) ? nextAllowed.get(inputKey) : 0;
      if (nowTick < allowedAt) continue;

      const result = attemptTransferOne(inputKey);
      const didTransfer = !!result?.ok;
      if (didTransfer) transfersThisTick++;

      const info = resolveBlockInfo(inputKey);
      let interval = cfg.perInputIntervalTicks;
      if (info && info.block) {
        const s = getSpeed(info.block);
        interval = Math.max(1, (s && s.intervalTicks) ? s.intervalTicks : cfg.perInputIntervalTicks);
      }
      if (!didTransfer) {
        const reason = result?.reason;
        if (reason === "full" || reason === "no_options") {
          const level = bumpBackoff(inputKey);
          interval += getBackoffTicks(level);
        }
      } else {
        clearBackoff(inputKey);
      }
      nextAllowed.set(inputKey, nowTick + interval);

      if (didTransfer) budget--;
    }
    if (debugEnabled) {
      debugState.inputsScanned += scanned;
      debugState.transfersStarted += transfersThisTick;
    }

    persistInflightIfNeeded();
    persistLevelsIfNeeded();
    persistOutputLevelsIfNeeded();
    persistPrismLevelsIfNeeded();
    if (debugEnabled) postDebugStats(inputKeys.length);
  }

  function resolveBlockInfo(inputKey) {
    try {
      const pos = parseKey(inputKey);
      if (!pos) return null;
      const dim = world.getDimension(pos.dimId);
      if (!dim) return null;
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) return null;
      return { dim, block, pos };
    } catch {
      return null;
    }
  }

  function makeResult(ok, reason) {
    return { ok: !!ok, reason: reason || (ok ? "ok" : "fail") };
  }

  function getFilterForBlock(block) {
    try {
      const c = getFilterContainer(block);
      if (c) return c;
      return getFilterSetForBlock(world, block);
    } catch {
      return null;
    }
  }

  function attemptTransferOne(inputKey) {
    const inputInfo = resolveBlockInfo(inputKey);
    if (!inputInfo) return makeResult(false, "no_input");

    const inDim = inputInfo.dim;
    const inBlock = inputInfo.block;
    if (!inBlock || inBlock.typeId !== INPUT_ID) return makeResult(false, "no_input");

    const inInfo = getAttachedInventoryInfo(inBlock, inDim);
    if (!inInfo || !inInfo.container || !inInfo.block) return makeResult(false, "no_container");
    const inContainer = inInfo.container;
    const inContainerKey = getContainerKey(inInfo.block);

    const inputFilter = getFilterForBlock(inBlock);
    const pull = findFirstMatchingSlot(inContainer, inputFilter);
    if (!pull) return makeResult(false, "no_item");

    const inSlot = pull.slot;
    const inStack = pull.stack;
    if (!inStack || inStack.amount <= 0) return makeResult(false, "no_item");

    const options = (typeof findPathForInput === "function")
      ? findPathForInput(inputKey, nowTick)
      : null;
    if (!options || !Array.isArray(options) || options.length === 0) return makeResult(false, "no_options");

    const filteredOptions = filterOutputsByWhitelist(options, inStack.typeId, resolveBlockInfo, getFilterForBlock);
    if (!filteredOptions || filteredOptions.length === 0) return makeResult(false, "no_options");
    if (debugEnabled) {
      debugState.outputOptionsTotal += filteredOptions.length;
      debugState.outputOptionsMax = Math.max(debugState.outputOptionsMax, filteredOptions.length);
    }

    const dim = inputInfo.dim;
    if (!dim) return makeResult(false, "no_input");

    const previewLevel = getNextInputLevel(inputKey);
    let pathInfo = null;
    let outInfo = null;
    let outBlock = null;
    let outContainerInfo = null;
    let containerKey = null;
    let transferAmount = 0;
    let sawFull = false;

    const candidates = filteredOptions.slice();
    while (candidates.length > 0) {
      const pick = pickWeightedRandom(candidates);
      if (!pick || !Array.isArray(pick.path) || pick.path.length === 0) break;
      if (pick.path.length > MAX_STEPS) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      if (!validatePathStart(dim, pick.path)) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const info = resolveBlockInfo(pick.outputKey);
      if (!info || !info.block || info.block.typeId !== OUTPUT_ID) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const cInfo = getAttachedInventoryInfo(info.block, info.dim);
      if (!cInfo || !cInfo.container || !cInfo.block) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const cKey = getContainerKey(cInfo.block);
      if (!cKey) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }
      if (inContainerKey && cKey === inContainerKey) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      if (fullContainers.has(cKey)) {
        sawFull = true;
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const available = getTotalCountForType(inContainer, inStack.typeId);
      const desiredAmount = getTransferAmount(previewLevel, inStack);
      const capacity = getInsertCapacityWithReservations(cKey, cInfo.container, inStack.typeId, inStack);
      const amount = Math.min(desiredAmount, available, capacity);
      if (amount <= 0) {
        if (getContainerCapacityWithReservations(cKey, cInfo.container) <= 0) {
          fullContainers.add(cKey);
          sawFull = true;
        }
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      pathInfo = pick;
      outInfo = info;
      outBlock = info.block;
      outContainerInfo = cInfo;
      containerKey = cKey;
      transferAmount = amount;
      break;
    }

    if (!pathInfo || !outInfo || !outBlock || !outContainerInfo || !containerKey) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      return makeResult(false, sawFull ? "full" : "no_options");
    }

    if (!validatePathStart(dim, pathInfo.path)) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      return makeResult(false, "no_options");
    }

    const firstStep = pathInfo.path[0];
    const firstBlock = inDim.getBlock({ x: firstStep.x, y: firstStep.y, z: firstStep.z });
    if (!spawnOrbStep(inDim, inBlock.location, firstStep, previewLevel, inBlock, firstBlock)) {
      return makeResult(false, "no_spawn");
    }

    const current = inContainer.getItem(inSlot);
    if (!current || current.typeId !== inStack.typeId || current.amount <= 0) return makeResult(false, "no_item");

    if (!decrementInputSlotsForType(inContainer, inStack.typeId, transferAmount)) return makeResult(false, "no_item");

    const level = noteTransferAndGetLevel(inputKey, inBlock);
    inflight.push({
      dimId: inputInfo.pos.dimId,
      itemTypeId: inStack.typeId,
      amount: transferAmount,
      path: pathInfo.path,
      stepIndex: 0,
      stepTicks: getOrbStepTicks(level),
      ticksUntilStep: getOrbStepTicks(level),
      outputKey: pathInfo.outputKey,
      containerKey: containerKey,
      startPos: { x: inputInfo.pos.x, y: inputInfo.pos.y, z: inputInfo.pos.z },
      level: level,
    });
    reserveContainerSlot(containerKey, inStack.typeId, transferAmount);
    inflightDirty = true;

    return makeResult(true, "ok");
  }

  function tickInFlight() {
    if (inflight.length === 0) return;

    for (let i = inflight.length - 1; i >= 0; i--) {
      const job = inflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        finalizeJob(job);
        inflight.splice(i, 1);
        inflightDirty = true;
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const dim = world.getDimension(job.dimId);
      if (!dim) continue;

      const curBlock = dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (job.stepIndex < job.path.length - 1) {
        if (!isPathBlock(curBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          inflight.splice(i, 1);
          inflightDirty = true;
          continue;
        }
      }

      if (nextIdx < job.path.length - 1) {
        if (!isPathBlock(nextBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          inflight.splice(i, 1);
          inflightDirty = true;
          continue;
        }
      }

      if (job.stepIndex < job.path.length - 1) {
        if (curBlock?.typeId === PRISM_ID) {
          notePrismPassage(key(job.dimId, cur.x, cur.y, cur.z), curBlock);
        }
      }

      spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock);
      job.stepIndex = nextIdx;
      job.ticksUntilStep = job.stepTicks || cfg.orbStepTicks;
      inflightDirty = true;
    }
  }

  function postDebugStats(inputCount) {
    if ((nowTick - lastDebugTick) < debugInterval) return;
    lastDebugTick = nowTick;

    const pathStats = (typeof getPathStats === "function") ? getPathStats() : null;

    let queuedContainers = 0;
    let queuedEntries = 0;
    let queuedItems = 0;
    let queuedMax = 0;
    for (const queue of queueByContainer.values()) {
      if (!queue) continue;
      queuedContainers++;
      queuedEntries += queue.length;
      queuedMax = Math.max(queuedMax, queue.length);
      for (const job of queue) {
        queuedItems += Math.max(0, job?.amount | 0);
      }
    }

    const bfsLabel = pathStats
      ? ` bfs=${pathStats.searches}:${pathStats.visitedTotal}/${pathStats.visitedMax} out=${pathStats.outputsTotal}/${pathStats.outputsMax}`
      : "";

    const msg =
      `Chaos Transfer | inputs=${inputCount} scanned=${debugState.inputsScanned} ` +
      `xfer=${debugState.transfersStarted} inflight=${inflight.length} ` +
      `qC=${queuedContainers} qE=${queuedEntries} qI=${queuedItems} qMax=${queuedMax} ` +
      `full=${fullContainers.size} opts=${debugState.outputOptionsTotal}/${debugState.outputOptionsMax}` +
      bfsLabel;

    for (const player of world.getAllPlayers()) {
      try {
        if (debugUseActionBar && player?.onScreenDisplay?.setActionBar) {
          player.onScreenDisplay.setActionBar(msg);
        } else if (typeof player.sendMessage === "function") {
          player.sendMessage(msg);
        }
      } catch {
        // ignore
      }
    }

    resetDebugState();
  }

  function finalizeJob(job) {
    if (!job.containerKey) {
      const dim = world.getDimension(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      return;
    }
    const outInfo = resolveBlockInfo(job.outputKey);
    if (!outInfo) {
      const dim = world.getDimension(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    const outBlock = outInfo.block;
    if (!outBlock || outBlock.typeId !== OUTPUT_ID) {
      dropItemAt(outInfo.dim, outBlock?.location || outInfo.pos, job.itemTypeId, job.amount);
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    const outContainerInfo = getAttachedInventoryInfo(outBlock, outInfo.dim);
    if (!outContainerInfo || !outContainerInfo.container || !outContainerInfo.block) {
      dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    if (tryInsertAmount(outContainerInfo.container, job.itemTypeId, job.amount)) {
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      noteOutputTransfer(job.outputKey, outBlock);
      return;
    }

    enqueuePendingForContainer(job.containerKey, job.itemTypeId, job.amount, job.outputKey);
  }

  function noteTransferAndGetLevel(inputKey, block) {
    const blockLevel = (block?.permutation?.getState("chaos:level") | 0) || 1;
    const minCount = getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = transferCounts.has(inputKey) ? transferCounts.get(inputKey) : 0;
    const storedLevel = getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    transferCounts.set(inputKey, next);
    levelsDirty = true;
    const level = getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
    updateBlockLevel(block, level);
    return level;
  }

  function getNextInputLevel(inputKey) {
    const current = transferCounts.has(inputKey) ? transferCounts.get(inputKey) : 0;
    return getLevelForCount(current + 1, cfg.levelStep, cfg.maxLevel);
  }

  function getLevelForCount(count, step, maxLevel) {
    const base = Math.max(1, step | 0);
    const cap = Math.max(1, maxLevel | 0);
    let needed = base;
    let total = 0;
    const c = Math.max(0, count | 0);
    for (let lvl = 1; lvl <= cap; lvl++) {
      total += needed;
      if (c < total) return lvl;
      needed *= 2;
    }
    return cap;
  }

  function getMinCountForLevel(level, step) {
    const base = Math.max(1, step | 0);
    const lvl = Math.max(1, level | 0);
    let needed = base;
    let total = 0;
    for (let i = 1; i < lvl; i++) {
      total += needed;
      needed *= 2;
    }
    return total;
  }

  function getTransferAmount(level, stack) {
    const maxItems = Math.max(1, cfg.maxItemsPerOrb | 0);
    const lvl = Math.max(1, level | 0);
    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const cap = Math.min(maxItems, maxStack);
    if (lvl <= 1) return 1;
    const steps = Math.max(0, (cfg.maxLevel | 0) - lvl);
    const desired = Math.floor(cap / Math.pow(2, steps));
    return Math.max(1, Math.min(cap, desired));
  }

  function getOrbStepTicks(level) {
    const safeLevel = Math.max(1, level | 0);
    const base = Math.max(1, cfg.orbStepTicks | 0);
    const minTicks = Math.max(1, cfg.minOrbStepTicks | 0);
    const scale = Math.pow(2, Math.max(0, safeLevel - 1));
    return Math.max(minTicks, Math.floor(base / scale));
  }

  function updateBlockLevel(block, level) {
    try {
      if (!block || block.typeId !== INPUT_ID) return;
      const perm = block.permutation;
      if (!perm) return;
      const current = perm.getState("chaos:level");
      if ((current | 0) === (level | 0)) return;
      const next = perm.withState("chaos:level", level | 0);
      block.setPermutation(next);
      spawnLevelUpBurst(block);
    } catch {
      // ignore
    }
  }

  function notePrismPassage(prismKey, block) {
    const blockLevel = (block?.permutation?.getState("chaos:level") | 0) || 1;
    const minCount = getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = prismCounts.has(prismKey) ? prismCounts.get(prismKey) : 0;
    const storedLevel = getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    prismCounts.set(prismKey, next);
    prismLevelsDirty = true;
    const level = getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
    updatePrismBlockLevel(block, level);
  }

  function updatePrismBlockLevel(block, level) {
    try {
      if (!block || block.typeId !== PRISM_ID) return;
      const perm = block.permutation;
      if (!perm) return;
      const current = perm.getState("chaos:level");
      if ((current | 0) === (level | 0)) return;
      const next = perm.withState("chaos:level", level | 0);
      block.setPermutation(next);
      spawnLevelUpBurst(block);
    } catch {
      // ignore
    }
  }

  function noteOutputTransfer(outputKey, block) {
    const blockLevel = (block?.permutation?.getState("chaos:level") | 0) || 1;
    const minCount = getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = outputCounts.has(outputKey) ? outputCounts.get(outputKey) : 0;
    const storedLevel = getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    outputCounts.set(outputKey, next);
    outputLevelsDirty = true;
    const level = getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
    updateOutputBlockLevel(block, level);
  }

  function updateOutputBlockLevel(block, level) {
    try {
      if (!block || block.typeId !== OUTPUT_ID) return;
      const perm = block.permutation;
      if (!perm) return;
      const current = perm.getState("chaos:level");
      if ((current | 0) === (level | 0)) return;
      const next = perm.withState("chaos:level", level | 0);
      block.setPermutation(next);
      spawnLevelUpBurst(block);
    } catch {
      // ignore
    }
  }

  function rebuildReservationsFromInflight() {
    reservedByContainer.clear();
    for (const job of inflight) {
      if (!job || !job.containerKey || !job.itemTypeId) continue;
      const amt = Math.max(1, job.amount | 0);
      reserveContainerSlot(job.containerKey, job.itemTypeId, amt);
    }
  }

  function spawnOrbStep(dim, from, to, level, fromBlock, toBlock) {
    try {
      if (!FX || !FX.particleTransferItem) return false;
      const fxId = FX.particleTransferItem;
      const dir = normalizeDir(from, to);
      if (!dir) return false;

      const molang = new MolangVariableMap();
      const lifetime = getOrbLifetimeSeconds(level);
      const speed = getOrbVisualSpeed(from, to, dir, level, lifetime);
      const color = getOrbColor(level);
      if (typeof molang.setSpeedAndDirection === "function") {
        molang.setSpeedAndDirection("variable.chaos_move", speed, dir);
      }
      molang.setFloat("variable.chaos_move.speed", speed);
      molang.setFloat("variable.chaos_move.direction_x", dir.x);
      molang.setFloat("variable.chaos_move.direction_y", dir.y);
      molang.setFloat("variable.chaos_move.direction_z", dir.z);
      molang.setFloat("variable.chaos_color_r", color.r);
      molang.setFloat("variable.chaos_color_g", color.g);
      molang.setFloat("variable.chaos_color_b", color.b);
      molang.setFloat("variable.chaos_color_a", color.a);
      molang.setFloat("variable.chaos_lifetime", lifetime);

      const pos = {
        x: from.x + 0.5,
        y: from.y + 0.5,
        z: from.z + 0.5,
      };
      dim.spawnParticle(fxId, pos, molang);
      return true;
    } catch {
      return false;
    }
  }

  function spawnLevelUpBurst(block) {
    try {
      if (!block) return;
      const dim = block.dimension;
      const particleId = FX?.particleSuccess || FX?.particleBeamOutputBurst;
      if (!dim || !particleId) return;

      const count = Math.max(1, cfg.levelUpBurstCount | 0);
      const radius = Math.max(0, Number(cfg.levelUpBurstRadius) || 0.35);
      const base = block.location;
      for (let i = 0; i < count; i++) {
        const ox = (Math.random() * 2 - 1) * radius;
        const oy = (Math.random() * 2 - 1) * radius;
        const oz = (Math.random() * 2 - 1) * radius;
        dim.spawnParticle(particleId, {
          x: base.x + 0.5 + ox,
          y: base.y + 0.6 + oy,
          z: base.z + 0.5 + oz,
        });
      }
    } catch {
      // ignore
    }
  }

  function normalizeDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(len) || len <= 0.0001) return null;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  function getOrbLifetimeSeconds(level) {
    const stepTicks = Math.max(1, getOrbStepTicks(Math.max(1, level | 0)));
    const base = stepTicks / 20;
    const scale = Math.max(0.1, Number(cfg.orbLifetimeScale) || 0.5);
    return Math.max(0.03, base * scale);
  }

  function getOrbVisualSpeed(from, to, dir, level, lifetimeSeconds) {
    // Keep particle motion visually in sync with step cadence.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const life = Math.max(0.05, Number(lifetimeSeconds) || 0.05);
    const baseSpeed = dist / life;
    const minScale = Math.max(0.1, Number(cfg.orbVisualMinSpeedScale) || 0.6);
    const maxScale = Math.max(minScale, Number(cfg.orbVisualMaxSpeedScale) || 1.0);
    return Math.max(0.1, baseSpeed * Math.max(minScale, Math.min(maxScale, 1.0)));
  }

  function getOrbColor(level) {
    const lvl = Math.min(cfg.maxLevel | 0, Math.max(1, level | 0));
    const palette = [
      { r: 0.78, g: 0.8, b: 0.84, a: 1.0 }, // L1 iron
      { r: 1.0, g: 0.78, b: 0.2, a: 1.0 },  // L2 gold
      { r: 0.2, g: 0.9, b: 0.9, a: 1.0 },   // L3 diamond
      { r: 0.2, g: 0.2, b: 0.24, a: 1.0 },  // L4 netherite
      { r: 0.85, g: 0.65, b: 1.0, a: 1.0 }, // L5 masterwork
    ];
    return palette[lvl - 1] || palette[0];
  }

  function dropItemAt(dim, loc, typeId, amount) {
    try {
      const dropLoc = findDropLocation(dim, loc);
      const amt = Math.max(1, amount | 0);
      let remaining = amt;
      let maxStack = 64;
      try {
        const probe = new ItemStack(typeId, 1);
        maxStack = probe.maxAmount || 64;
      } catch {}
      while (remaining > 0) {
        const n = Math.min(maxStack, remaining);
        dim.spawnItem(new ItemStack(typeId, n), dropLoc);
        remaining -= n;
      }
    } catch {
      // ignore
    }
  }

  return { start, stop };
}

function sanitizeInflightEntry(entry) {
  try {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.dimId !== "string") return null;
    if (typeof entry.itemTypeId !== "string") return null;
    if (!Array.isArray(entry.path) || entry.path.length === 0) return null;
    if (!Number.isFinite(entry.stepIndex)) entry.stepIndex = 0;
    if (!Number.isFinite(entry.ticksUntilStep)) entry.ticksUntilStep = 1;
    if (!Number.isFinite(entry.stepTicks)) entry.stepTicks = entry.ticksUntilStep;
    if (!Number.isFinite(entry.amount)) entry.amount = 1;
    entry.amount = Math.max(1, entry.amount | 0);
    if (typeof entry.containerKey !== "string") entry.containerKey = null;
    if (!entry.outputKey || typeof entry.outputKey !== "string") return null;
    if (!entry.startPos || !Number.isFinite(entry.startPos.x)) entry.startPos = null;
    return entry;
  } catch {
    return null;
  }
}

function loadInflightStateFromWorld(world, inflight, cfg) {
  const raw = loadInflight(world);
  inflight.length = 0;
  for (const entry of raw) {
    const clean = sanitizeInflightEntry(entry);
    if (!clean) continue;
    if (clean.path.length > MAX_STEPS) continue;
    if (clean.ticksUntilStep < 1) clean.ticksUntilStep = cfg.orbStepTicks;
    if (clean.stepTicks < 1) clean.stepTicks = cfg.orbStepTicks;
    if (!clean.containerKey && clean.outputKey) {
      const outInfo = resolveBlockInfoStatic(world, clean.outputKey);
      if (outInfo?.block) {
        const cInfo = getAttachedInventoryInfo(outInfo.block, outInfo.dim);
        if (cInfo?.block) clean.containerKey = getContainerKey(cInfo.block);
      }
    }
    inflight.push(clean);
  }
}

function persistInflightStateToWorld(world, inflight) {
  saveInflight(world, inflight);
}

function validatePathStart(dim, path) {
  const checks = Math.min(2, path.length);
  for (let i = 0; i < checks; i++) {
    const p = path[i];
    const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
    if (!isPathBlock(b)) return false;
  }
  return true;
}

function isPathBlock(block) {
  if (!block) return false;
  const id = block.typeId;
  return id === BEAM_ID || id === PRISM_ID || id === OUTPUT_ID || id === INPUT_ID;
}

function findDropLocation(dim, loc) {
  const candidates = [
    { x: loc.x, y: loc.y + 1, z: loc.z },
    { x: loc.x + 1, y: loc.y, z: loc.z },
    { x: loc.x - 1, y: loc.y, z: loc.z },
    { x: loc.x, y: loc.y, z: loc.z + 1 },
    { x: loc.x, y: loc.y, z: loc.z - 1 },
  ];
  for (const c of candidates) {
    const b = dim.getBlock(c);
    if (b && b.typeId === "minecraft:air") {
      return { x: c.x + 0.5, y: c.y + 0.1, z: c.z + 0.5 };
    }
  }
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function pickWeightedRandom(outputs) {
  if (!outputs || outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0];

  let total = 0;
  const weights = outputs.map((o) => {
    const len = Array.isArray(o.path) ? o.path.length : 1;
    const clamped = Math.min(Math.max(1, len), PATH_WEIGHT_MAX_LEN);
    const base = 1 / clamped;
    const jitter = PATH_WEIGHT_RANDOM_MIN + (Math.random() * (PATH_WEIGHT_RANDOM_MAX - PATH_WEIGHT_RANDOM_MIN));
    const w = base * jitter;
    total += w;
    return w;
  });

  let r = Math.random() * total;
  for (let i = 0; i < outputs.length; i++) {
    r -= weights[i];
    if (r <= 0) return outputs[i];
  }
  return outputs[outputs.length - 1];
}

function getAttachedInventoryContainer(nodeBlock, dimension) {
  const info = getAttachedInventoryInfo(nodeBlock, dimension);
  return info ? info.container : null;
}

function getAttachedInventoryInfo(nodeBlock, dimension) {
  try {
    const attachedDir = getAttachedDirectionFromStates(nodeBlock);
    if (attachedDir) {
      const adj = getNeighborBlock(nodeBlock, dimension, attachedDir);
      const c = getInventoryContainer(adj);
      if (c) return { container: c, block: adj };
    }

    const dirs = ["north", "south", "east", "west", "up", "down"];
    const hits = [];
    for (const d of dirs) {
      const adj = getNeighborBlock(nodeBlock, dimension, d);
      const c = getInventoryContainer(adj);
      if (c) hits.push({ container: c, block: adj });
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return hits[0];
    return null;
  } catch (_) {
    return null;
  }
}

function getAttachedDirectionFromStates(block) {
  try {
    const perm = block.permutation;
    if (!perm) return null;

    try {
      const face = perm.getState("minecraft:block_face");
      if (typeof face === "string") return face;
    } catch (_) {}

    try {
      const fd = perm.getState("minecraft:facing_direction");
      if (typeof fd === "number") {
        const front = numFacingToDir(fd);
        return oppositeDir(front);
      }
    } catch (_) {}

    try {
      const cd = perm.getState("minecraft:cardinal_direction");
      if (typeof cd === "string") return oppositeDir(cd);
    } catch (_) {}

    return null;
  } catch (_) {
    return null;
  }
}

function numFacingToDir(n) {
  switch (n) {
    case 0: return "down";
    case 1: return "up";
    case 2: return "north";
    case 3: return "south";
    case 4: return "west";
    case 5: return "east";
    default: return null;
  }
}

function oppositeDir(dir) {
  switch (dir) {
    case "north": return "south";
    case "south": return "north";
    case "east": return "west";
    case "west": return "east";
    case "up": return "down";
    case "down": return "up";
    default: return null;
  }
}

function getNeighborBlock(block, dimension, dir) {
  try {
    if (!block || !dimension) return null;
    const loc = block.location;
    let nx = loc.x, ny = loc.y, nz = loc.z;
    switch (dir) {
      case "north": nz -= 1; break;
      case "south": nz += 1; break;
      case "west": nx -= 1; break;
      case "east": nx += 1; break;
      case "down": ny -= 1; break;
      case "up": ny += 1; break;
      default: return null;
    }
    return dimension.getBlock({ x: nx, y: ny, z: nz });
  } catch (_) {
    return null;
  }
}

function getInventoryContainer(block) {
  try {
    if (!block) return null;
    const inv = block.getComponent("minecraft:inventory");
    if (!inv) return null;
    const c = inv.container;
    return c || null;
  } catch (_) {
    return null;
  }
}

function getFilterContainer(block) {
  try {
    if (!block) return null;
    const inv = block.getComponent("minecraft:inventory");
    if (!inv) return null;
    return inv.container || null;
  } catch (_) {
    return null;
  }
}

function isFilterEmpty(filter) {
  try {
    if (!filter) return true;
    if (filter instanceof Set) return filter.size === 0;
    const size = filter.size;
    for (let i = 0; i < size; i++) {
      const it = filter.getItem(i);
      if (it && it.amount > 0) return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

function getFilterSet(filter) {
  try {
    if (!filter) return null;
    if (filter instanceof Set) return filter;
    const size = filter.size;
    const set = new Set();
    for (let i = 0; i < size; i++) {
      const it = filter.getItem(i);
      if (!it || it.amount <= 0) continue;
      set.add(it.typeId);
    }
    return set;
  } catch (_) {
    return null;
  }
}

function filterAllows(filter, typeId) {
  if (!filter || !typeId) return true;
  if (isFilterEmpty(filter)) return true;
  const set = getFilterSet(filter);
  if (!set || set.size === 0) return true;
  return set.has(typeId);
}

function filterOutputsByWhitelist(options, typeId, resolveBlockInfo, getFilterForBlock) {
  try {
    if (!options || options.length === 0) return [];
    if (typeof resolveBlockInfo !== "function") return options;
    const prioritized = [];
    const allowAll = [];
    for (const opt of options) {
      if (!opt || !opt.outputKey) continue;
      const outInfo = resolveBlockInfo(opt.outputKey);
      if (!outInfo || !outInfo.block || outInfo.block.typeId !== OUTPUT_ID) continue;
      const filter = (typeof getFilterForBlock === "function")
        ? getFilterForBlock(outInfo.block)
        : getFilterContainer(outInfo.block);
      if (!filterAllows(filter, typeId)) continue;
      if (filter && !isFilterEmpty(filter)) prioritized.push(opt);
      else allowAll.push(opt);
    }
    return (prioritized.length > 0) ? prioritized : allowAll;
  } catch (_) {
    return [];
  }
}

function findFirstNonEmptySlot(container) {
  try {
    const size = container.size;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (it && it.amount > 0) return { slot: i, stack: it };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function findFirstMatchingSlot(container, filterContainer) {
  try {
    if (!filterContainer || isFilterEmpty(filterContainer)) {
      return findFirstNonEmptySlot(container);
    }

    const allowed = getFilterSet(filterContainer);
    if (!allowed || allowed.size === 0) return findFirstNonEmptySlot(container);

    const size = container.size;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it || it.amount <= 0) continue;
      if (allowed.has(it.typeId)) return { slot: i, stack: it };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function getTotalCountForType(container, typeId) {
  try {
    if (!container || !typeId) return 0;
    const size = container.size;
    let total = 0;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      total += it.amount | 0;
    }
    return Math.max(0, total);
  } catch (_) {
    return 0;
  }
}

function decrementInputSlotsForType(container, typeId, count) {
  try {
    if (!container || !typeId || count <= 0) return false;
    let remaining = count | 0;
    const size = container.size;
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      const take = Math.min(remaining, it.amount | 0);
      if (take <= 0) continue;
      if (it.amount === take) {
        if (!clearSlotSafe(container, i)) return false;
      } else {
        const dec = (typeof it.clone === "function") ? it.clone() : it;
        dec.amount = it.amount - take;
        try { container.setItem(i, dec); } catch (_) { return false; }
      }
      remaining -= take;
    }
    return remaining <= 0;
  } catch (_) {
    return false;
  }
}

function decrementInputSlotSafe(container, slot, originalStack, count) {
  try {
    if (!container || !originalStack) return false;
    if (originalStack.amount < count) return false;

    if (originalStack.amount === count) {
      return clearSlotSafe(container, slot);
    } else {
      const dec = (typeof originalStack.clone === "function") ? originalStack.clone() : cloneAsOne(originalStack);
      dec.amount = originalStack.amount - count;
      try {
        container.setItem(slot, dec);
        return true;
      } catch (_) {
        return false;
      }
    }
  } catch (_) {
    return false;
  }
}

function clearSlotSafe(container, slot) {
  try {
    try { container.setItem(slot, undefined); return true; } catch (_) {}
    try { container.setItem(slot, null); return true; } catch (_) {}
    try { container.setItem(slot); return true; } catch (_) {}
    return false;
  } catch (_) {
    return false;
  }
}

function cloneAsOne(stack) {
  try {
    if (typeof stack.clone === "function") {
      const c = stack.clone();
      c.amount = 1;
      return c;
    }
  } catch (_) {}

  try {
    return new ItemStack(stack.typeId, 1);
  } catch (_) {
    return stack;
  }
}

function canInsertOne(container, typeId) {
  try {
    const size = container.size;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || 64;
      if (it.amount < max) return true;
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (!it2) return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

function canInsertOneWithReservations(containerKey, container, typeId) {
  try {
    const capacity = getInsertCapacityWithReservations(containerKey, container, typeId, null);
    return capacity >= 1;
  } catch (_) {
    return false;
  }
}

function getInsertCapacityWithReservations(containerKey, container, typeId, stack) {
  try {
    const size = container.size;
    let stackRoom = 0;
    let emptySlots = 0;
    const maxStack = Math.max(1, stack?.maxAmount || 64);

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) {
        emptySlots++;
        continue;
      }
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || maxStack;
      if (it.amount < max) stackRoom += (max - it.amount);
    }

    const reservedTotal = getReservedForContainer(containerKey).total;
    const capacity = stackRoom + (emptySlots * maxStack);
    return Math.max(0, capacity - reservedTotal);
  } catch (_) {
    return 0;
  }
}

function getReservedForContainer(containerKey) {
  const entry = reservedByContainer.get(containerKey);
  if (!entry) return { total: 0, byType: new Map() };
  return entry;
}

function reserveContainerSlot(containerKey, typeId, count) {
  if (!containerKey || !typeId || count <= 0) return;
  let entry = reservedByContainer.get(containerKey);
  if (!entry) {
    entry = { total: 0, byType: new Map() };
    reservedByContainer.set(containerKey, entry);
  }
  entry.total += count;
  const prev = entry.byType.get(typeId) || 0;
  entry.byType.set(typeId, prev + count);
}

function releaseContainerSlot(containerKey, typeId, count) {
  if (!containerKey || !typeId || count <= 0) return;
  const entry = reservedByContainer.get(containerKey);
  if (!entry) return;
  entry.total = Math.max(0, entry.total - count);
  const prev = entry.byType.get(typeId) || 0;
  const next = Math.max(0, prev - count);
  if (next === 0) entry.byType.delete(typeId);
  else entry.byType.set(typeId, next);
  if (entry.total <= 0 && entry.byType.size === 0) reservedByContainer.delete(containerKey);
}

function tryInsertOne(container, oneStack) {
  try {
    if (!container || !oneStack) return false;

    const size = container.size;
    const typeId = oneStack.typeId;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;

      const max = it.maxAmount || 64;
      if (it.amount >= max) continue;

      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = Math.min(max, it.amount + 1);

      try {
        container.setItem(i, next);
        return true;
      } catch (_) {}
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      try {
        container.setItem(j, oneStack);
        return true;
      } catch (_) {}
    }

    return false;
  } catch (_) {
    return false;
  }
}

function tryInsertAmount(container, typeId, amount) {
  try {
    if (!container || !typeId) return false;
    let remaining = Math.max(1, amount | 0);
    if (remaining <= 0) return false;

    const probe = new ItemStack(typeId, 1);
    const maxStack = probe.maxAmount || 64;
    const size = container.size;

    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || maxStack;
      if (it.amount >= max) continue;

      const add = Math.min(max - it.amount, remaining);
      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = it.amount + add;

      try {
        container.setItem(i, next);
        remaining -= add;
      } catch (_) {}
    }

    for (let j = 0; j < size && remaining > 0; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      const add = Math.min(maxStack, remaining);
      try {
        container.setItem(j, new ItemStack(typeId, add));
        remaining -= add;
      } catch (_) {}
    }

    return remaining <= 0;
  } catch (_) {
    return false;
  }
}
