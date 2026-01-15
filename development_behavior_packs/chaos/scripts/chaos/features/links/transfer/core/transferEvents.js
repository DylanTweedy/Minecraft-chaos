// scripts/chaos/features/links/transfer/core/transferEvents.js

import {
  canonicalizePrismKey,
  key,
  prismKeyFromBlock,
} from "../keys.js";
import { isPrismBlock } from "../config.js";
import { isHoldingLens } from "../../../../items/insightLens.js";
import { isWearingGoggles } from "../../../../items/insightGoggles.js";

/**
 * Subscribes to world events once, and marks adjacent prisms dirty when containers change.
 * Returns an unsubscribe function (best-effort; Bedrock events don't always support unsub cleanly).
 *
 * IMPORTANT: This MUST be "subscribe once" to avoid duplicate handlers.
 */
export function subscribeTransferDirtyEvents(deps) {
  const world = deps?.world;
  const cacheManager = deps?.cacheManager;
  const linkGraph = deps?.linkGraph;

  const markAdjacentPrismsDirty = deps?.markAdjacentPrismsDirty;
  const getInventoryContainer = deps?.getInventoryContainer;
  const isFurnaceBlock = deps?.isFurnaceBlock;
  const logError = deps?.logError || (() => {});
  const debugLog = deps?.debugLog || (() => {});
  const placementDiagnosticsEnabled = deps?.placementDiagnosticsEnabled !== false;

  const lastPlacementKeyByPlayer = new Map();

  if (!world?.afterEvents) return () => {};

  // Guard: prevent multiple subscriptions
  if (deps?.state) {
    if (deps.state.eventsSubscribed) return () => {};
    deps.state.eventsSubscribed = true;
  }

  const subs = [];

  function sendPlacementChat(msg, player) {
    try {
      if (!world || typeof world.getAllPlayers !== "function") return;
      const text = typeof msg === "string" ? msg : null;
      if (!text) return;
      const players = player ? [player] : world.getAllPlayers();
      if (!players) return;
      for (const player of players) {
        try {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage("§f" + text);
          }
        } catch {}
      }
    } catch {}
  }

  function hasInsightGear(player) {
    return player && (isHoldingLens(player) || isWearingGoggles(player));
  }

  function emitPlacementDiagnostic(block, player) {
    try {
      if (!placementDiagnosticsEnabled || !block || !linkGraph) return;
      if (!isPrismBlock(block)) return;
      if (!player || !hasInsightGear(player)) return;
      const dimId = block.dimension?.id;
      const loc = block.location;
      if (!dimId || !loc) return;
      const rawKey = prismKeyFromBlock(block) || key(dimId, loc.x, loc.y, loc.z);
      const prismKey = canonicalizePrismKey(rawKey);
      if (!prismKey) return;
      const playerId = player?.id;
      if (playerId) {
        const lastKey = lastPlacementKeyByPlayer.get(playerId);
        if (lastKey === prismKey) return;
        lastPlacementKeyByPlayer.set(playerId, prismKey);
      }
      const neighbors = linkGraph.getNeighbors?.(prismKey) || [];
      const stats =
        typeof linkGraph.getGraphStats === "function" ? linkGraph.getGraphStats() : null;
      const registered =
        typeof linkGraph.hasNode === "function"
          ? linkGraph.hasNode(prismKey)
          : neighbors.length > 0;
      const dimShort =
        typeof dimId === "string" ? dimId.split(":").pop() || dimId : dimId || "unknown";
      const roundedPos = `${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
      const messageParts = [
        `[Prism] dim=${dimShort} pos=${roundedPos}`,
        `key=${prismKey}`,
        `neighbors=${neighbors.length}`,
        `registered=${registered ? "Y" : "N"}`,
      ];
      if (stats) {
        messageParts.push(`graph prisms=${stats.prisms} edges=${stats.edges}`);
      }
      if (!registered) {
        const sampleKeys =
          typeof linkGraph.getGraphSampleKeys === "function"
            ? linkGraph.getGraphSampleKeys(3)
            : [];
        if (Array.isArray(sampleKeys) && sampleKeys.length > 0) {
          messageParts.push(`sampleKeys=${sampleKeys.join(",")}`);
        }
      }
      sendPlacementChat(messageParts.join(" | "), player);
    } catch {}
  }

  function invalidateBlockSafe(dim, loc) {
    try {
      if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
        cacheManager.invalidateBlock(dim.id, loc);
      }
    } catch {}
  }

  function isContainerish(block) {
    try {
      if (!block) return false;
      // furnace check first (you already treat these as special)
      if (typeof isFurnaceBlock === "function" && isFurnaceBlock(block)) return true;
      // normal container check
      if (typeof getInventoryContainer === "function") {
        const c = getInventoryContainer(block);
        if (c) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Player places block
  try {
    const evt = world.afterEvents.playerPlaceBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const block = ev?.block;
          if (!block) return;

          if (isPrismBlock(block)) {
            emitPlacementDiagnostic(block, ev?.player);
          }

          if (!isContainerish(block)) return;

          markAdjacentPrismsDirty?.(block.dimension, block.location, "player_placed_container");
          invalidateBlockSafe(block.dimension, block.location);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "playerPlaceBlock" });
    }
  } catch (err) {
    logError("Error subscribing to playerPlaceBlock", err);
  }

  // Player breaks block
  try {
    const evt = world.afterEvents.playerBreakBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const dim = ev?.dimension;
          const loc = ev?.block?.location;
          if (!dim || !loc) return;

          // We can't reliably test "was container" from permutation; be conservative.
          markAdjacentPrismsDirty?.(dim, loc, "player_broke_block");
          invalidateBlockSafe(dim, loc);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "playerBreakBlock" });
    }
  } catch (err) {
    logError("Error subscribing to playerBreakBlock", err);
  }

  // Entity places block (if supported)
  try {
    const evt = world.afterEvents.entityPlaceBlock;
    if (evt && typeof evt.subscribe === "function") {
      const cb = (ev) => {
        try {
          const block = ev?.block;
          if (!block) return;

          if (isPrismBlock(block)) {
            emitPlacementDiagnostic(block, ev?.player);
          }

          if (!isContainerish(block)) return;

          markAdjacentPrismsDirty?.(block.dimension, block.location, "entity_placed_container");
          invalidateBlockSafe(block.dimension, block.location);
        } catch {}
      };
      evt.subscribe(cb);
      subs.push({ evt, cb, name: "entityPlaceBlock" });
    }
  } catch (err) {
    logError("Error subscribing to entityPlaceBlock", err);
  }

  debugLog?.(`[TransferEvents] subscribed: ${subs.map(s => s.name).join(", ")}`);

  // Best-effort unsubscribe (Bedrock doesn't always support unsubscribe)
  return () => {
    try {
      for (const s of subs) {
        try {
          if (s?.evt && typeof s.evt.unsubscribe === "function") {
            s.evt.unsubscribe(s.cb);
          }
        } catch {}
      }
      if (deps?.state) deps.state.eventsSubscribed = false;
    } catch {}
  };
}
