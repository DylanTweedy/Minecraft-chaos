// scripts/chaos/features/logistics/runtime/controller.js

import { DEFAULTS, isPrismBlock, CRUCIBLE_ID, getPrismTier } from "../config.js";
import { mergeCfg } from "../utils.js";
import { createTransferPipeline } from "./pipeline.js";
import { createBudgets } from "./budgets.js";

import { createPrismRegistry } from "../network/graph/prismRegistry.js";
import { createLinkGraph } from "../network/graph/linkGraph.js";
import { subscribeLinkEvents } from "./events/linkEvents.js";

import { createCacheManager } from "../core/cache.js";
import { createLevelsManager } from "../systems/levels.js";
import { createFilterIndexManager } from "../systems/filterIndex.js";

import { getFilterSetForBlock } from "../network/filters.js";
import { getTotalCountForType } from "../util/inventoryAdapter.js";

import { createDiscoveryPhase } from "../phases/01_discovery/index.js";
import { createIndexingPhase } from "../phases/02_indexing/index.js";
import { createExportSelectionPhase } from "../phases/03_exportSelection/index.js";
import { createDestinationResolvePhase } from "../phases/04_destinationResolve/index.js";
import { createArrivalPhase } from "../phases/05_arrival/index.js";
import { createDeparturePhase } from "../phases/06_departure/index.js";
import { createInventoryIOPhase } from "../phases/07_inventoryIO/index.js";
import { createMovementPhase } from "../phases/08_movement/index.js";
import { createFluxConversionPhase } from "../phases/09_fluxConversion/index.js";
import { createPersistInsightPhase } from "../phases/10_persistInsight/index.js";

import { createPrismState } from "../state/prisms.js";
import { deserializeOrb, resetOrbIds } from "../state/orbs.js";

import { runMigrations } from "../persistence/migrations.js";
import { safeJsonParse } from "../persistence/serializers.js";
import { DP_LOGISTICS_ORBS, DP_LOGISTICS_PRISM_LEVELS, DP_LOGISTICS_DRIFT_CURSORS } from "../persistence/dpKeys.js";
import { loadMapFromWorld } from "../phases/10_persistInsight/persist.js";

import { emitTrace } from "../../../core/insight/trace.js";

export function createNetworkTransferController(deps = {}, opts = {}) {
  const { world, system, FX } = deps;
  const cfg = mergeCfg(DEFAULTS, opts);

  const prismRegistry = createPrismRegistry({ world, cfg });
  const linkGraph = createLinkGraph({ world, cfg });
  const linkEvents = subscribeLinkEvents({ world, system, prismRegistry, linkGraph, debugLog: () => {} });

  const cacheManager = createCacheManager(
    { world, getContainerCapacityWithReservations: () => 0, getTotalCountForType },
    cfg
  );

  const prismState = createPrismState();
  const prismCounts = new Map();
  const levelsManager = createLevelsManager(cfg, { prismCounts }, {});

  const filterIndex = createFilterIndexManager({
    world,
    resolvePrismKeysFromWorld: () => prismRegistry.resolvePrismKeys(),
    resolveBlockInfo: (k) => cacheManager.resolveBlockInfoCached(k),
    getFilterSetForBlock,
    isPrismBlock,
  });

  const budgets = createBudgets(cfg);

  const state = {
    orbs: [],
    orbsById: new Map(),
    prismCounts,
    prismState,
    arrivalQueue: [],
    spawnQueue: [],
  };

  function loadState() {
    runMigrations(world);
    const rawOrbs = safeJsonParse(world.getDynamicProperty(DP_LOGISTICS_ORBS), []);
    state.orbs.length = 0;
    state.orbsById.clear();
    if (Array.isArray(rawOrbs)) {
      for (const entry of rawOrbs) {
        const orb = deserializeOrb(entry);
        if (!orb) continue;
        state.orbs.push(orb);
        state.orbsById.set(orb.id, orb);
      }
    }
    resetOrbIds(state.orbs.length + 1);

    const loadedCounts = loadMapFromWorld(world, DP_LOGISTICS_PRISM_LEVELS);
    for (const [k, v] of loadedCounts.entries()) {
      prismCounts.set(k, v);
    }

    const loadedCursors = loadMapFromWorld(world, DP_LOGISTICS_DRIFT_CURSORS);
    for (const [k, v] of loadedCursors.entries()) {
      prismState.driftCursorByPrism.set(k, v);
    }
  }

  const phases = [
    createDiscoveryPhase(),
    createIndexingPhase(),
    createExportSelectionPhase(),
    createDestinationResolvePhase(),
    createArrivalPhase(),
    createDeparturePhase(),
    createInventoryIOPhase(),
    createMovementPhase(),
    createFluxConversionPhase(),
    createPersistInsightPhase(),
  ];

  const pipeline = createTransferPipeline({ name: "LogisticsTransfer", phases });

  let nowTick = 0;
  let tickId = null;

  function onTick() {
    nowTick++;
    budgets.reset();
    cacheManager.updateTick(nowTick);
    cacheManager.resetTickCaches();

    const ctx = {
      nowTick,
      cfg,
      world,
      system,
      FX,
      budgets,
      insightCounts: Object.create(null),
      state,
      prismKeys: prismRegistry.resolvePrismKeys(),
      indexes: {},
      exportIntents: [],
      departureIntents: [],
      arrivalQueue: state.arrivalQueue,
      spawnQueue: state.spawnQueue,
      ioQueue: { extracts: [], inserts: [] },
      services: {
        prismRegistry,
        linkGraph,
        linkEvents,
        cacheManager,
        levelsManager,
        filterIndex,
        resolveBlockInfo: (k) => cacheManager.resolveBlockInfoCached(k),
        getFilterSetForBlock,
        isPrismBlock,
        getPrismTier,
        CRUCIBLE_ID,
        emitTrace,
      },
    };

    pipeline.runTick(ctx);
  }

  function start() {
    loadState();
    if (tickId !== null) return;
    tickId = system.runInterval(onTick, 1);
  }

  function stop() {
    if (tickId === null) return;
    system.clearRun(tickId);
    tickId = null;
  }

  return { start, stop };
}

