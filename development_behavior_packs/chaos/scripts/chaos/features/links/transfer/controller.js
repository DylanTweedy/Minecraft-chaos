// scripts/chaos/features/links/transfer/controller.js
import { ItemStack, MolangVariableMap } from "@minecraft/server";
import {
  DEFAULTS,
  INPUT_ID,
  OUTPUT_ID,
  PRISM_ID,
  CRYSTALLIZER_ID,
  CRYSTAL_FLUX_WEIGHT,
  MAX_STEPS,
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,
} from "./config.js";
import { mergeCfg } from "./utils.js";
import {
  loadBeamsMap,
  loadInputLevels,
  saveInputLevels,
  loadOutputLevels,
  saveOutputLevels,
  loadPrismLevels,
  savePrismLevels,
} from "./storage.js";
import { loadInflightStateFromWorld, persistInflightStateToWorld } from "./inflight.js";
import { key, parseKey, getContainerKey } from "./keys.js";
import {
  getAttachedInventoryInfo,
  getInventoryContainer,
  isFurnaceBlock,
  getFurnaceSlots,
  tryInsertAmountForContainer,
  getTotalCountForType,
  findInputSlotForContainer,
  decrementInputSlotSafe,
  decrementInputSlotsForType,
} from "./inventory.js";
import { getFilterContainer, filterOutputsByWhitelist } from "./filters.js";
import {
  getInsertCapacityWithReservations,
  getReservedForContainer,
  reserveContainerSlot,
  releaseContainerSlot,
  clearReservations,
} from "./reservations.js";
import {
  validatePathStart,
  isPathBlock,
  isNodeBlock,
  findFirstPrismKeyInPath,
  buildNodePathSegments,
  buildFluxFxSegments,
  findDropLocation,
  pickWeightedRandomWithBias,
} from "./path.js";
import { findOutputRouteFromNode, findCrystallizerRouteFromOutput } from "./routes.js";
import { runTransferPipeline } from "./pipeline.js";
import { getFilterSetForBlock } from "../filters.js";
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../fx/fx.js";

export function createNetworkTransferController(deps, opts) {
  const world = deps.world;
  const system = deps.system;
  const FX = deps.FX;
  const getSpeedForInput = deps.getSpeedForInput;
  const findPathForInput = deps.findPathForInput;
  const invalidateInput = deps.invalidateInput;
  const getPathStats = deps.getPathStats;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);

  let cursor = 0;
  let tickId = null;
  let nowTick = 0;

  const nextAllowed = new Map();
  const inflight = [];
  const fluxFxInflight = [];
  let inflightDirty = false;
  let inflightStepDirty = false;
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
  let lastDebugTick = 0;
  const debugState = {
    inputsScanned: 0,
    transfersStarted: 0,
    outputOptionsTotal: 0,
    outputOptionsMax: 0,
    orbSpawns: 0,
    orbFxSkipped: 0,
    fluxFxSpawns: 0,
    inputMapReloads: 0,
    blockLookups: 0,
    containerLookups: 0,
    inventoryScans: 0,
    dpSaves: 0,
    fluxGenChecks: 0,
    fluxGenHits: 0,
    fluxRefineCalls: 0,
    fluxRefined: 0,
    fluxMutated: 0,
    msQueues: 0,
    msInflight: 0,
    msFluxFx: 0,
    msScan: 0,
    msPersist: 0,
    msTotal: 0,
  };
  let cachedInputKeys = null;
  let cachedInputsStamp = null;
  let orbFxBudgetUsed = 0;
  const blockCache = new Map();
  const containerInfoCache = new Map();
  const insertCapacityCache = new Map();
  const totalCapacityCache = new Map();
  const totalCountCache = new Map();
  const dimCache = new Map();

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
    debugState.orbSpawns = 0;
    debugState.orbFxSkipped = 0;
    debugState.fluxFxSpawns = 0;
    debugState.inputMapReloads = 0;
    debugState.blockLookups = 0;
    debugState.containerLookups = 0;
    debugState.inventoryScans = 0;
    debugState.dpSaves = 0;
    debugState.fluxGenChecks = 0;
    debugState.fluxGenHits = 0;
    debugState.fluxRefineCalls = 0;
    debugState.fluxRefined = 0;
    debugState.fluxMutated = 0;
    debugState.msQueues = 0;
    debugState.msInflight = 0;
    debugState.msFluxFx = 0;
    debugState.msScan = 0;
    debugState.msPersist = 0;
    debugState.msTotal = 0;
  }

  function resetTickCaches() {
    blockCache.clear();
    containerInfoCache.clear();
    insertCapacityCache.clear();
    totalCapacityCache.clear();
    totalCountCache.clear();
    dimCache.clear();
  }

  function getDimensionCached(dimId) {
    if (!dimId) return null;
    if (dimCache.has(dimId)) return dimCache.get(dimId);
    const dim = world.getDimension(dimId);
    dimCache.set(dimId, dim || null);
    return dim || null;
  }

  function resolveBlockInfoCached(blockKey) {
    try {
      if (!blockKey) return null;
      if (blockCache.has(blockKey)) return blockCache.get(blockKey);
      const pos = parseKey(blockKey);
      if (!pos) {
        blockCache.set(blockKey, null);
        return null;
      }
      const dim = getDimensionCached(pos.dimId);
      if (!dim) {
        blockCache.set(blockKey, null);
        return null;
      }
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) {
        blockCache.set(blockKey, null);
        return null;
      }
      const info = { dim, block, pos };
      blockCache.set(blockKey, info);
      if (debugEnabled) debugState.blockLookups++;
      return info;
    } catch {
      return null;
    }
  }

  function getBlockCached(dimId, pos) {
    try {
      if (!dimId || !pos) return null;
      const blockKey = key(dimId, pos.x, pos.y, pos.z);
      const info = resolveBlockInfoCached(blockKey);
      return info?.block || null;
    } catch {
      return null;
    }
  }

  function resolveContainerInfoCached(containerKey) {
    if (!containerKey) return null;
    if (containerInfoCache.has(containerKey)) return containerInfoCache.get(containerKey);
    const info = resolveBlockInfoCached(containerKey);
    if (!info || !info.block) {
      containerInfoCache.set(containerKey, null);
      return null;
    }
    const container = getInventoryContainer(info.block);
    if (!container) {
      containerInfoCache.set(containerKey, null);
      return null;
    }
    const result = { dim: info.dim, block: info.block, container, pos: info.pos };
    containerInfoCache.set(containerKey, result);
    if (debugEnabled) debugState.containerLookups++;
    return result;
  }

  function getTotalCountForTypeCached(containerKey, container, typeId) {
    const keyId = `${containerKey}|${typeId}`;
    if (totalCountCache.has(keyId)) return totalCountCache.get(keyId);
    if (debugEnabled) debugState.inventoryScans++;
    const total = getTotalCountForType(container, typeId);
    totalCountCache.set(keyId, total);
    return total;
  }

  function getInsertCapacityCached(containerKey, container, typeId, stack) {
    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const keyId = `${containerKey}|${typeId}|${maxStack}`;
    if (insertCapacityCache.has(keyId)) return insertCapacityCache.get(keyId);
    if (debugEnabled) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getInsertCapacityWithReservations(containerKey, container, typeId, stack, info?.block);
    insertCapacityCache.set(keyId, capacity);
    return capacity;
  }

  function getContainerCapacityCached(containerKey, container) {
    if (totalCapacityCache.has(containerKey)) return totalCapacityCache.get(containerKey);
    if (debugEnabled) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getContainerCapacityWithReservations(containerKey, container, info?.block);
    totalCapacityCache.set(containerKey, capacity);
    return capacity;
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
    if (!inflightDirty && !inflightStepDirty) return;
    if (inflightDirty && inflight.length === 0) {
      persistInflightStateToWorld(world, inflight);
      if (debugEnabled) debugState.dpSaves++;
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;
      return;
    }
    const interval = Math.max(1, cfg.inflightSaveIntervalTicks | 0);
    if ((nowTick - lastSaveTick) < interval) return;
    persistInflightStateToWorld(world, inflight);
    if (debugEnabled) debugState.dpSaves++;
    inflightDirty = false;
    inflightStepDirty = false;
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
    if (debugEnabled) debugState.dpSaves++;
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
    if (debugEnabled) debugState.dpSaves++;
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
    if (debugEnabled) debugState.dpSaves++;
    prismLevelsDirty = false;
    lastPrismLevelsSaveTick = nowTick;
  }

  function enqueuePendingForContainer(containerKey, itemTypeId, amount, outputKey, reservedTypeId) {
    if (!containerKey || !itemTypeId || amount <= 0) return;
    let queue = queueByContainer.get(containerKey);
    if (!queue) {
      queue = [];
      queueByContainer.set(containerKey, queue);
    }
    queue.push({ itemTypeId, amount, outputKey, reservedTypeId: reservedTypeId || itemTypeId });
    const info = resolveContainerInfoCached(containerKey);
    if (!isFurnaceBlock(info?.block)) fullContainers.add(containerKey);
  }

  function resolveContainerInfo(containerKey) {
    return resolveContainerInfoCached(containerKey);
  }

  function getContainerCapacityWithReservations(containerKey, container, containerBlock) {
    try {
      if (!containerKey || !container) return 0;
      const slots = getFurnaceSlots(container, containerBlock);
      const size = container.size;
      let stackRoom = 0;
      let emptySlots = 0;

      const indices = slots ? [slots.input, slots.fuel] : null;
      const loopCount = indices ? indices.length : size;
      for (let i = 0; i < loopCount; i++) {
        const slot = indices ? indices[i] : i;
        const it = container.getItem(slot);
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
          releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
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

      if (tryInsertAmountForContainer(info.container, info.block, job.itemTypeId, job.amount)) {
        queue.shift();
        releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
        const outInfo = job.outputKey ? resolveBlockInfo(job.outputKey) : null;
        if (outInfo?.block && outInfo.block.typeId === OUTPUT_ID) {
          noteOutputTransfer(job.outputKey, outInfo.block);
        }
        if (queue.length === 0) {
          queueByContainer.delete(containerKey);
          fullContainers.delete(containerKey);
        }
      } else if (!isFurnaceBlock(info.block)) {
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
      const capacity = getContainerCapacityCached(containerKey, info.container);
      if (capacity > 0) fullContainers.delete(containerKey);
    }
  }

  function onTick() {
    nowTick++;
    resetTickCaches();
    orbFxBudgetUsed = 0;

    const tickStart = debugEnabled ? Date.now() : 0;

    if (debugEnabled) {
      runTransferPipeline([
        () => {
          const t0 = Date.now();
          tickOutputQueues();
          tickFullContainers();
          debugState.msQueues += (Date.now() - t0);
        },
        () => {
          const t1 = Date.now();
          tickInFlight();
          debugState.msInflight += (Date.now() - t1);
        },
        () => {
          const t2 = Date.now();
          tickFluxFxInFlight();
          debugState.msFluxFx += (Date.now() - t2);
        },
      ]);
    } else {
      runTransferPipeline([
        tickOutputQueues,
        tickFullContainers,
        tickInFlight,
        tickFluxFxInFlight,
      ]);
    }

    const scanStart = debugEnabled ? Date.now() : 0;
    const inputKeys = getInputKeys();
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
      debugState.msScan += (Date.now() - scanStart);
    }

    if (debugEnabled) {
      const t3 = Date.now();
      persistInflightIfNeeded();
      persistLevelsIfNeeded();
      persistOutputLevelsIfNeeded();
      persistPrismLevelsIfNeeded();
      debugState.msPersist += (Date.now() - t3);
      debugState.msTotal += (Date.now() - tickStart);
    } else {
      persistInflightIfNeeded();
      persistLevelsIfNeeded();
      persistOutputLevelsIfNeeded();
      persistPrismLevelsIfNeeded();
    }
    if (debugEnabled) postDebugStats(inputKeys.length);
  }

  function getInputKeys() {
    try {
      if (typeof getNetworkStamp === "function") {
        const stamp = getNetworkStamp();
        if (cachedInputKeys && cachedInputsStamp === stamp) return cachedInputKeys;
        const map = loadBeamsMap(world);
        cachedInputKeys = Object.keys(map || {});
        cachedInputsStamp = stamp;
        if (debugEnabled) debugState.inputMapReloads++;
        return cachedInputKeys;
      }
    } catch {
      // ignore
    }
    const map = loadBeamsMap(world);
    return Object.keys(map || {});
  }

  function resolveBlockInfo(inputKey) {
    return resolveBlockInfoCached(inputKey);
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
    const pull = findInputSlotForContainer(inContainer, inInfo.block, inputFilter);
    if (!pull) return makeResult(false, "no_item");

    const inSlot = pull.slot;
    const inStack = pull.stack;
    if (!inStack || inStack.amount <= 0) return makeResult(false, "no_item");

    const options = (typeof findPathForInput === "function")
      ? findPathForInput(inputKey, nowTick)
      : null;
    if (!options || !Array.isArray(options) || options.length === 0) return makeResult(false, "no_options");

    const filteredOptions = filterOutputsByWhitelist(
      options,
      inStack.typeId,
      resolveBlockInfo,
      getFilterForBlock,
      { OUTPUT_ID, CRYSTALLIZER_ID }
    );
    if (!filteredOptions || filteredOptions.length === 0) return makeResult(false, "no_options");
    if (debugEnabled) {
      debugState.outputOptionsTotal += filteredOptions.length;
      debugState.outputOptionsMax = Math.max(debugState.outputOptionsMax, filteredOptions.length);
    }

    const dim = inputInfo.dim;
    if (!dim) return makeResult(false, "no_input");

    const isFlux = isFluxTypeId(inStack.typeId);

    const previewLevel = getNextInputLevel(inputKey);
    let pathInfo = null;
    let outInfo = null;
    let outBlock = null;
    let outContainerInfo = null;
    let containerKey = null;
    let transferAmount = 0;
    let sawFull = false;
    let outputType = "output";

    let candidates = filteredOptions.slice();
    if (!isFlux) {
      candidates = candidates.filter((c) => (c?.outputType || "output") !== "crystal");
    }
    if (candidates.length === 0) return makeResult(false, "no_options");

    const isFurnaceInput = isFurnaceBlock(inInfo.block);
    const available = isFurnaceInput
      ? Math.max(0, inStack.amount | 0)
      : getTotalCountForTypeCached(inContainerKey, inContainer, inStack.typeId);
    while (candidates.length > 0) {
      const pick = pickWeightedRandomWithBias(candidates, (opt) => {
        const type = opt?.outputType || "output";
        if (isFlux && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
        return 1.0;
      });
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
      if (!info || !info.block) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const pickedType = pick.outputType || "output";
      if (pickedType === "crystal") {
        if (info.block.typeId !== CRYSTALLIZER_ID) {
          candidates.splice(candidates.indexOf(pick), 1);
          continue;
        }
        const desiredAmount = getTransferAmount(previewLevel, inStack);
        const amount = Math.min(desiredAmount, available);
        if (amount <= 0) {
          candidates.splice(candidates.indexOf(pick), 1);
          continue;
        }
        pathInfo = pick;
        outInfo = info;
        outBlock = info.block;
        outContainerInfo = null;
        containerKey = null;
        transferAmount = amount;
        outputType = "crystal";
        break;
      }

      if (info.block.typeId !== OUTPUT_ID) {
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

      const desiredAmount = getTransferAmount(previewLevel, inStack);
      const capacity = getInsertCapacityCached(cKey, cInfo.container, inStack.typeId, inStack);
      const amount = Math.min(desiredAmount, available, capacity);
      if (amount <= 0) {
        if (!isFurnaceBlock(cInfo.block) && getContainerCapacityCached(cKey, cInfo.container) <= 0) {
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
      outputType = "output";
      break;
    }

    if (!pathInfo || !outInfo || !outBlock) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      return makeResult(false, sawFull ? "full" : "no_options");
    }
    if (outputType === "output" && (!outContainerInfo || !containerKey)) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      return makeResult(false, sawFull ? "full" : "no_options");
    }

    if (!validatePathStart(dim, pathInfo.path)) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      return makeResult(false, "no_options");
    }

    const suppressOrb = (outputType === "crystal" && isFluxTypeId(inStack.typeId));
    const firstStep = pathInfo.path[0];
    const firstBlock = getBlockCached(inputInfo.pos.dimId, firstStep) || inDim.getBlock({ x: firstStep.x, y: firstStep.y, z: firstStep.z });
    const nodePath = buildNodePathSegments(inDim, pathInfo.path, inputInfo.pos);
    const travelPath = nodePath?.points || pathInfo.path;
    const segmentLengths = nodePath?.lengths || null;
      // Initial orb spawn disabled to avoid duplicate first-segment FX.

    const current = inContainer.getItem(inSlot);
    if (!current || current.typeId !== inStack.typeId || current.amount <= 0) return makeResult(false, "no_item");

    if (isFurnaceInput) {
      if (!decrementInputSlotSafe(inContainer, inSlot, current, transferAmount)) return makeResult(false, "no_item");
    } else {
      if (!decrementInputSlotsForType(inContainer, inStack.typeId, transferAmount)) return makeResult(false, "no_item");
    }

    const prismKey = findFirstPrismKeyInPath(dim, inputInfo.pos.dimId, pathInfo.path);
    const level = noteTransferAndGetLevel(inputKey, inBlock);
    inflight.push({
      dimId: inputInfo.pos.dimId,
      itemTypeId: inStack.typeId,
      amount: transferAmount,
      path: travelPath,
      stepIndex: 0,
      stepTicks: getOrbStepTicks(level),
      speedScale: 1.0,
      outputKey: pathInfo.outputKey,
      outputType: outputType,
      suppressOrb: suppressOrb,
      containerKey: containerKey,
      prismKey: prismKey,
      startPos: { x: inputInfo.pos.x, y: inputInfo.pos.y, z: inputInfo.pos.z },
      level: level,
      segmentLengths: segmentLengths,
      ticksUntilStep: 0,
      refinedItems: (outputType === "crystal" && isFluxTypeId(inStack.typeId))
        ? [{ typeId: inStack.typeId, amount: transferAmount }]
        : null,
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
      const dim = getDimensionCached(job.dimId);
      if (!dim) continue;

      const curBlock = getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (curBlock?.typeId === PRISM_ID && job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
        applyPrismRefineToFxJob(job, curBlock);
      }
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
          applyPrismSpeedBoost(job, curBlock);
          if (isFluxTypeId(job.itemTypeId)) {
            applyPrismRefineToJob(job, curBlock);
          }
        }
      }

      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      if (!job.suppressOrb) {
        spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock, job.itemTypeId, segLen, stepTicks);
      }
      job.stepIndex = nextIdx;
      job.ticksUntilStep = stepTicks * Math.max(1, segLen | 0);
      inflightStepDirty = true;
    }
  }

  function tickFluxFxInFlight() {
    if (fluxFxInflight.length === 0) return;
    for (let i = fluxFxInflight.length - 1; i >= 0; i--) {
      const job = fluxFxInflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        finalizeFluxFxJob(job);
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const dim = getDimensionCached(job.dimId);
      if (!dim) {
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const curBlock = getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (curBlock?.typeId === PRISM_ID) {
        applyPrismSpeedBoost(job, curBlock);
        if (job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
          applyPrismRefineToFxJob(job, curBlock);
        }
      }
      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      if (spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock, job.itemTypeId, segLen, stepTicks) && debugEnabled) {
        debugState.fluxFxSpawns++;
      }
      job.stepIndex = nextIdx;
      job.ticksUntilStep = stepTicks * Math.max(1, segLen | 0);
    }
  }

  function finalizeFluxFxJob(job) {
    try {
      const dim = getDimensionCached(job.dimId);
      if (!dim) return;

      if (job.crystalKey) {
        if (job.skipCrystalAdd) return;
        const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        let added = 0;
        for (const entry of itemsToConvert) {
          const value = getFluxValueForItem(entry.typeId);
          if (value > 0) {
            const gained = addFluxForItem(job.crystalKey, entry.typeId, entry.amount);
            if (gained > 0) added += gained;
          } else {
            dropItemAt(dim, job.dropPos || { x: 0, y: 0, z: 0 }, entry.typeId, entry.amount);
          }
        }
        if (added > 0) {
          const p = parseKey(job.crystalKey);
          if (p) {
            const block = dim.getBlock({ x: p.x, y: p.y, z: p.z });
            if (block) fxFluxGenerate(block, FX);
          }
        }
        return;
      }

      if (job.containerKey) {
        const info = resolveContainerInfo(job.containerKey);
        const itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        if (info?.container) {
          let allInserted = true;
          for (const entry of itemsToInsert) {
            if (!tryInsertAmountForContainer(info.container, info.block, entry.typeId, entry.amount)) {
              allInserted = false;
              enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
            }
          }
          if (allInserted) return;
        } else {
          for (const entry of itemsToInsert) {
            enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
          }
        }
        return;
      }

      if (job.suppressDrop) return;
      if (job.dropPos) {
        dropItemAt(dim, job.dropPos, job.itemTypeId, job.amount);
      }
    } catch {
      // ignore
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
      `fluxFx=${fluxFxInflight.length}/${cfg.maxFluxFxInFlight | 0} ` +
      `orbFx=${debugState.orbSpawns} orbFxSkip=${debugState.orbFxSkipped} fluxFxSp=${debugState.fluxFxSpawns} ` +
      `mapReloads=${debugState.inputMapReloads} ` +
      `fluxGen=${debugState.fluxGenHits}/${debugState.fluxGenChecks} refine=${debugState.fluxRefined}/${debugState.fluxMutated}/${debugState.fluxRefineCalls} ` +
      `blk=${debugState.blockLookups} cont=${debugState.containerLookups} inv=${debugState.inventoryScans} dp=${debugState.dpSaves} ` +
      `msQ=${debugState.msQueues} msIn=${debugState.msInflight} msFx=${debugState.msFluxFx} msScan=${debugState.msScan} msSave=${debugState.msPersist} msTot=${debugState.msTotal} ` +
      `qC=${queuedContainers} qE=${queuedEntries} qI=${queuedItems} qMax=${queuedMax} ` +
      `full=${fullContainers.size} opts=${debugState.outputOptionsTotal}/${debugState.outputOptionsMax}` +
      bfsLabel;

    for (const player of world.getAllPlayers()) {
      try {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(msg);
        }
      } catch {
        // ignore
      }
    }

    resetDebugState();
  }

  function finalizeJob(job) {
    if (job?.outputType === "crystal") {
      if (job.skipCrystalAdd) return;
      const outInfo = resolveBlockInfo(job.outputKey);
      if (!outInfo || !outInfo.block || outInfo.block.typeId !== CRYSTALLIZER_ID) {
        const dim = getDimensionCached(job.dimId);
        if (dim) {
          const fallback = job.path[job.path.length - 1] || job.startPos;
          if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
        }
        return;
      }

      const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
        ? job.refinedItems
        : [{ typeId: job.itemTypeId, amount: job.amount }];

      let added = 0;
      for (const entry of itemsToConvert) {
        const value = getFluxValueForItem(entry.typeId);
        if (value > 0) {
          const gained = addFluxForItem(job.outputKey, entry.typeId, entry.amount);
          if (gained > 0) added += gained;
        } else {
          dropItemAt(outInfo.dim, outInfo.block.location, entry.typeId, entry.amount);
        }
      }
      if (added > 0) fxFluxGenerate(outInfo.block, FX);
      return;
    }

    if (!job.containerKey) {
      const dim = getDimensionCached(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      return;
    }
    const outInfo = resolveBlockInfo(job.outputKey);
    if (!outInfo) {
      const dim = getDimensionCached(job.dimId);
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

    let itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    if (!job.refinedItems && job.prismKey) {
      const prismInfo = resolveBlockInfo(job.prismKey);
      if (debugEnabled) debugState.fluxRefineCalls++;
      const refined = tryRefineFluxInTransfer({
        prismBlock: prismInfo?.block,
        itemTypeId: job.itemTypeId,
        amount: job.amount,
        FX: FX,
      });
      if (debugEnabled && refined) {
        debugState.fluxRefined += Math.max(0, refined.refined | 0);
        debugState.fluxMutated += Math.max(0, refined.mutated | 0);
      }
      if (refined?.items?.length) itemsToInsert = refined.items;
    }

    let allInserted = true;
    for (const entry of itemsToInsert) {
      if (!tryInsertAmountForContainer(outContainerInfo.container, outContainerInfo.block, entry.typeId, entry.amount)) {
        allInserted = false;
        enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
      }
    }

    if (allInserted) {
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      noteOutputTransfer(job.outputKey, outBlock);
      if (debugEnabled) debugState.fluxGenChecks++;
      const crystalRoute = findCrystallizerRouteFromOutput(outBlock, job.dimId);
      const fluxGenerated = tryGenerateFluxOnTransfer({
        outputBlock: outBlock,
        destinationInventory: outContainerInfo.container,
        inputBlock: job.startPos ? outInfo.dim.getBlock(job.startPos) : null,
        path: job.path,
        getAttachedInventoryInfo,
        getBlockAt: (pos, dim) => {
          if (!pos) return null;
          const dimId = dim?.id || job.dimId;
          return getBlockCached(dimId, pos);
        },
        scheduleFluxTransferFx: enqueueFluxTransferFx,
        scheduleFluxTransferFxPositions: enqueueFluxTransferFxPositions,
        getContainerKey,
        transferLevel: job.level,
        transferStepTicks: job.stepTicks || cfg.orbStepTicks,
        transferSpeedScale: 1.0,
        FX: FX,
        consumeFluxOutput: !!crystalRoute,
      });
      if (debugEnabled && fluxGenerated > 0) debugState.fluxGenHits++;
      if (fluxGenerated > 0 && crystalRoute) {
        if (typeof enqueueFluxTransferFxPositions === "function") {
          enqueueFluxTransferFxPositions(
            crystalRoute.path,
            crystalRoute.outputIndex,
            crystalRoute.targetIndex,
            "chaos:flux_1",
            job.level,
            {
              amount: fluxGenerated,
              dimId: job.dimId,
              suppressDrop: true,
              refineOnPrism: true,
              crystalKey: key(job.dimId, crystalRoute.crystalPos.x, crystalRoute.crystalPos.y, crystalRoute.crystalPos.z),
              stepTicks: job.stepTicks || cfg.orbStepTicks,
              speedScale: 1.0,
            }
          );
        }
      }
      return;
    }
  }

  function findPrismsInPath(path, dimId) {
    try {
      if (!Array.isArray(path) || path.length === 0) return [];
      const prisms = [];
      for (const p of path) {
        if (!p) continue;
        const b = getBlockCached(dimId, p);
        if (b?.typeId === PRISM_ID) prisms.push(b);
      }
      return prisms;
    } catch {
      return [];
    }
  }

  function applyPrismRefineChain(items, prismBlocks, speedScale) {
    let list = Array.isArray(items) ? items.slice() : [];
    if (!prismBlocks || prismBlocks.length === 0) return list;
    const scale = Math.max(0.1, Number(speedScale) || 1.0);
    for (const prismBlock of prismBlocks) {
      if (!prismBlock) continue;
      const next = [];
      for (const entry of list) {
        if (!entry || !isFluxTypeId(entry.typeId)) {
          next.push(entry);
          continue;
        }
        if (debugEnabled) debugState.fluxRefineCalls++;
        const refined = tryRefineFluxInTransfer({
          prismBlock,
          itemTypeId: entry.typeId,
          amount: entry.amount,
          FX: FX,
          speedScale: scale,
        });
        if (debugEnabled && refined) {
          debugState.fluxRefined += Math.max(0, refined.refined | 0);
          debugState.fluxMutated += Math.max(0, refined.mutated | 0);
        }
        if (refined?.items?.length) next.push(...refined.items);
        else next.push(entry);
      }
      list = next;
    }
    return list;
  }

  function applyPrismRefineToJob(job, prismBlock) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale);
    if (job.outputType === "crystal") {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  function applyPrismRefineToFxJob(job, prismBlock) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale);
    if (job.crystalKey) {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  function applyPrismSpeedBoost(job, prismBlock) {
    try {
      const level = (prismBlock?.permutation?.getState("chaos:level") | 0) || 1;
      const boost = PRISM_SPEED_BOOST_BASE + ((Math.max(1, level) - 1) * PRISM_SPEED_BOOST_PER_TIER);
      const current = Math.max(0.1, Number(job.speedScale) || 1.0);
      job.speedScale = Math.min(SPEED_SCALE_MAX, current * boost);
    } catch {
      // ignore
    }
  }

  function sendExoticsToOutput(prismBlock, job, exotics) {
    try {
      if (!prismBlock || !job || !Array.isArray(exotics) || exotics.length === 0) return;
      const route = findOutputRouteFromNode(prismBlock, job.dimId);
      if (!route) {
        for (const entry of exotics) {
          dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
        }
        return;
      }

      const outInfo = resolveBlockInfo(route.outputKey);
      const outBlock = outInfo?.block;
      const cInfo = outBlock ? getAttachedInventoryInfo(outBlock, outInfo.dim) : null;
      const containerKey = cInfo?.block ? getContainerKey(cInfo.block) : null;

      for (const entry of exotics) {
        let scheduled = false;
        if (containerKey && typeof enqueueFluxTransferFxPositions === "function") {
          enqueueFluxTransferFxPositions(
            route.path,
            route.startIndex,
            route.endIndex,
            entry.typeId,
            job.level || 1,
            {
              amount: entry.amount,
              dimId: job.dimId,
              containerKey,
              dropPos: outBlock?.location || prismBlock.location,
            }
          );
          scheduled = true;
        }
        if (!scheduled) {
          if (cInfo?.container && containerKey) {
            if (!tryInsertAmountForContainer(cInfo.container, cInfo.block, entry.typeId, entry.amount)) {
              enqueuePendingForContainer(containerKey, entry.typeId, entry.amount, route.outputKey, entry.typeId);
            }
          } else {
            dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function findOutputRouteFromNode(startBlock, dimId) {
    try {
      if (!startBlock || !dimId) return null;
      const dim = startBlock.dimension;
      if (!dim) return null;
      const startPos = startBlock.location;
      const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

      const queue = [];
      let qIndex = 0;
      const visited = new Set();
      const parent = new Map();
      queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "prism", key: startKey });
      visited.add(startKey);

      while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
        const cur = queue[qIndex++];
        const dirs = makeDirs();
        for (const d of dirs) {
          const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
          if (!edge) continue;
          const nextKey = key(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
          if (visited.has(nextKey)) continue;
          visited.add(nextKey);
          parent.set(nextKey, {
            prevKey: cur.key,
            edgePath: edge.path,
            nodePos: { x: edge.nodePos.x, y: edge.nodePos.y, z: edge.nodePos.z },
            nodeType: edge.nodeType,
          });

          if (edge.nodeType === "output") {
            const outBlock = dim.getBlock(edge.nodePos);
            if (!outBlock || outBlock.typeId !== OUTPUT_ID) {
              continue;
            }
            const cInfo = getAttachedInventoryInfo(outBlock, dim);
            const containerKey = cInfo?.block ? getContainerKey(cInfo.block) : null;
            if (!cInfo?.container || !containerKey) {
              continue;
            }
            return buildOutputRoute(startKey, nextKey, parent);
          }

          queue.push({ nodePos: edge.nodePos, nodeType: edge.nodeType, key: nextKey });
          if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildOutputRoute(startKey, targetKey, parent) {
    try {
      const steps = [];
      let curKey = targetKey;
      while (curKey && curKey !== startKey) {
        const info = parent.get(curKey);
        if (!info) break;
        steps.push(info);
        curKey = info.prevKey;
      }
      if (curKey !== startKey) return null;
      steps.reverse();

      const parsedStart = parseKey(startKey);
      if (!parsedStart) return null;
      const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];
      for (const step of steps) {
        if (Array.isArray(step.edgePath) && step.edgePath.length > 0) {
          for (const p of step.edgePath) forward.push({ x: p.x, y: p.y, z: p.z });
        }
        forward.push({ x: step.nodePos.x, y: step.nodePos.y, z: step.nodePos.z });
      }
      if (forward.length < 2) return null;

      const reversed = forward.slice().reverse();
      const outputPos = reversed[0];
      return {
        path: reversed,
        startIndex: reversed.length - 1,
        endIndex: 0,
        outputKey: targetKey,
        outputPos: { x: outputPos.x, y: outputPos.y, z: outputPos.z },
      };
    } catch {
      return null;
    }
  }

  function findCrystallizerRouteFromOutput(outputBlock, dimId) {
    try {
      if (!outputBlock || !dimId) return null;
      const dim = outputBlock.dimension;
      if (!dim) return null;
      const startPos = outputBlock.location;
      const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

      const queue = [];
      let qIndex = 0;
      const visited = new Set();
      const parent = new Map();
      queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "output", key: startKey });
      visited.add(startKey);

      while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
        const cur = queue[qIndex++];
        const dirs = makeDirs();
        for (const d of dirs) {
          const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
          if (!edge) continue;
          const nextKey = key(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
          if (visited.has(nextKey)) continue;
          visited.add(nextKey);
          parent.set(nextKey, {
            prevKey: cur.key,
            edgePath: edge.path,
            nodePos: { x: edge.nodePos.x, y: edge.nodePos.y, z: edge.nodePos.z },
            nodeType: edge.nodeType,
          });
          if (edge.nodeType === "crystal") {
            return buildCrystallizerRoute(startKey, nextKey, parent);
          }
          queue.push({ nodePos: edge.nodePos, nodeType: edge.nodeType, key: nextKey });
          if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildCrystallizerRoute(startKey, targetKey, parent) {
    try {
      const steps = [];
      let curKey = targetKey;
      while (curKey && curKey !== startKey) {
        const info = parent.get(curKey);
        if (!info) break;
        steps.push(info);
        curKey = info.prevKey;
      }
      if (curKey !== startKey) return null;
      steps.reverse();

      const parsedStart = parseKey(startKey);
      if (!parsedStart) return null;
      const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];
      for (const step of steps) {
        if (Array.isArray(step.edgePath) && step.edgePath.length > 0) {
          for (const p of step.edgePath) forward.push({ x: p.x, y: p.y, z: p.z });
        }
        forward.push({ x: step.nodePos.x, y: step.nodePos.y, z: step.nodePos.z });
      }
      if (forward.length < 2) return null;
      const reversed = forward.slice().reverse();
      const crystalPos = reversed[0];
      return {
        path: reversed,
        outputIndex: reversed.length - 1,
        targetIndex: 0,
        crystalPos: { x: crystalPos.x, y: crystalPos.y, z: crystalPos.z },
      };
    } catch {
      return null;
    }
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
    const prismStep = Number.isFinite(cfg.prismLevelStep) ? cfg.prismLevelStep : (cfg.levelStep * 2);
    const blockLevel = (block?.permutation?.getState("chaos:level") | 0) || 1;
    const minCount = getMinCountForLevel(blockLevel, prismStep);
    const stored = prismCounts.has(prismKey) ? prismCounts.get(prismKey) : 0;
    const storedLevel = getLevelForCount(stored, prismStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    prismCounts.set(prismKey, next);
    prismLevelsDirty = true;
    const level = getLevelForCount(next, prismStep, cfg.maxLevel);
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
    clearReservations();
    for (const job of inflight) {
      if (!job || !job.containerKey || !job.itemTypeId) continue;
      const amt = Math.max(1, job.amount | 0);
      reserveContainerSlot(job.containerKey, job.itemTypeId, amt);
    }
  }

  function spawnOrbStep(dim, from, to, level, fromBlock, toBlock, itemTypeId, lengthSteps, stepTicksOverride) {
    try {
      if (!FX || !FX.particleTransferItem) return false;
      let fxId = FX.particleTransferItem;
      if (itemTypeId && FX?.particleExoticOrbById && FX.particleExoticOrbById[itemTypeId]) {
        fxId = FX.particleExoticOrbById[itemTypeId] || fxId;
      } else if (itemTypeId && FX?.particleFluxOrbByTier && Array.isArray(FX.particleFluxOrbByTier)) {
        const tier = getFluxTier(itemTypeId);
        if (tier > 0) {
          const idx = tier - 1;
          fxId = FX.particleFluxOrbByTier[idx] || fxId;
        }
      }
      const maxOrbFx = Math.max(0, cfg.maxOrbFxPerTick | 0);
      if (maxOrbFx > 0 && orbFxBudgetUsed >= maxOrbFx) {
        if (debugEnabled) debugState.orbFxSkipped++;
        return true;
      }
      if (maxOrbFx > 0) orbFxBudgetUsed++;
      const dir = normalizeDir(from, to);
      if (!dir) return false;

      const molang = new MolangVariableMap();
      const steps = Math.max(1, lengthSteps | 0);
      const stepTicks = Math.max(1, Number(stepTicksOverride) || getOrbStepTicks(level));
      const lifetime = Math.max(0.05, (stepTicks * steps) / 20);
      const speed = getOrbVisualSpeed(from, to, dir, level, lifetime);
      const color = isFluxTypeId(itemTypeId)
        ? { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }
        : getOrbColor(level);
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
      queueFxParticle(dim, fxId, pos, molang);
      if (debugEnabled) debugState.orbSpawns++;
      return true;
    } catch {
      return false;
    }
  }

  function enqueueFluxTransferFx(pathBlocks, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathBlocks) || pathBlocks.length < 2) return;
      if (fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = pathBlocks[s]?.dimension?.id;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const b = pathBlocks[i];
        if (!b) continue;
        const loc = b.location;
        if (!loc) continue;
        path.push({ x: loc.x, y: loc.y, z: loc.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const segments = buildFluxFxSegments(getDimensionCached(dimId), path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch {
      // ignore
    }
  }

  function enqueueFluxTransferFxPositions(pathPositions, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathPositions) || pathPositions.length < 2) return;
      if (fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = insertInfo?.dimId || pathPositions[s]?.dimId || null;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const p = pathPositions[i];
        if (!p) continue;
        path.push({ x: p.x, y: p.y, z: p.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const segments = buildFluxFxSegments(getDimensionCached(dimId), path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch {
      // ignore
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
        queueFxParticle(dim, particleId, {
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
