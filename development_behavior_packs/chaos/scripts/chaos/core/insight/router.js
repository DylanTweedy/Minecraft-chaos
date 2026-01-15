// scripts/chaos/core/insight/router.js

import { system, world } from "@minecraft/server";
import { InsightConfig } from "./config.js";
import { getInsightState, getAllInsightStates, removeInsightState } from "./state.js";
import { dedupeMessages, buildChatHash, formatBatch } from "./format.js";
import { getContextMessages, getGlobalMessages, drainInsightErrors, requeueInsightErrors } from "./trace.js";
import { getGlobalSummaryMessages, getGlobalSummaryLabel } from "./transferStats.js";
import { registerHeldProvider, registerFocusProvider, resolveProvider, setFallbackProvider } from "./providers/registry.js";
import { ClockProvider } from "./providers/clock.js";
import { PrismProvider } from "./providers/prism.js";
import { FallbackProvider } from "./providers/fallback.js";
import { isHoldingLens } from "../../items/insightLens.js";
import { isWearingGoggles } from "../../items/insightGoggles.js";
import { makePrismKey } from "../../features/links/transfer/runtime/prismKeys.js";

let _started = false;
const MAX_ERROR_MESSAGES_PER_TICK = 3;
const ERROR_PREFIX = "§c[Chaos][Error]";

function formatInsightError(entry) {
  if (!entry) return "";
  const codeSegment = entry.code ? `[${entry.code}] ` : "";
  const contextLabel = entry.contextKey ? ` (${entry.contextKey})` : "";
  const text = entry.message ? String(entry.message) : "";
  return `${ERROR_PREFIX} ${codeSegment}${text}${contextLabel}`.trim();
}
const MAX_CHAT_HISTORY = 32;
const MAX_CHAT_LINES = 10;
const CHAT_DUMP_COOLDOWN = 20;

function enforceMapLimit(map, limit) {
  if (!map || typeof map.size !== "number") return;
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

function toIntervalTicks(hz) {
  const v = Number(hz) || 1;
  return Math.max(1, Math.round(20 / v));
}

function getHeldInfo(player) {
  let main = null;
  let offhand = null;

  try {
    const inv = player.getComponent("minecraft:inventory");
    const c = inv?.container;
    if (c) {
      const slot = player.selectedSlotIndex;
      if (slot >= 0 && slot < c.size) {
        const item = c.getItem(slot);
        if (item) {
          main = { typeId: item.typeId, slot, source: "main" };
        }
      }
    }
  } catch {}

  try {
    const eq = player.getComponent("minecraft:equippable");
    if (eq) {
      offhand = eq.getEquipment?.("offhand") || null;
      if (offhand) {
        offhand = { typeId: offhand.typeId, slot: "offhand", source: "offhand" };
      }
    }
  } catch {}

  return main || offhand;
}

function computeInsightActive(player, held) {
  if (isWearingGoggles(player)) return true;
  if (isHoldingLens(player)) return true;
  if (held?.typeId && InsightConfig.insightItems.includes(held.typeId)) return true;
  return false;
}

function focusScan(player, maxDistance) {
  try {
    const blockHit = player.getBlockFromViewDirection({ maxDistance });
    const block = blockHit?.block;
    if (block) {
      const loc = block.location;
      return {
        kind: "block",
        typeId: block.typeId,
        key: makePrismKey(block.dimension?.id, loc.x, loc.y, loc.z) ||
          `${block.dimension.id}|${loc.x},${loc.y},${loc.z}`,
        pos: { x: loc.x, y: loc.y, z: loc.z },
        dimId: block.dimension.id,
      };
    }
  } catch {}

  try {
    const entityHit = player.getEntitiesFromViewDirection?.({ maxDistance });
    const entity = entityHit?.[0]?.entity;
    if (entity) {
      const loc = entity.location;
      return {
        kind: "entity",
        typeId: entity.typeId,
        key: entity.id,
        pos: { x: loc.x, y: loc.y, z: loc.z },
        dimId: entity.dimension?.id || "",
      };
    }
  } catch {}

  return null;
}

function showTitle(player, enabled) {
  try {
    const title = enabled ? "Insight On" : "Insight Off";
    const subtitle = enabled ? "Crouch for details" : "";
    player.onScreenDisplay?.setTitle?.(title, {
      subtitle,
      fadeInDuration: 0,
      stayDuration: 20,
      fadeOutDuration: 10,
    });
  } catch {}
}

export function startInsightRouter(config = {}) {
  if (_started) return;
  _started = true;

  const cfg = { ...InsightConfig, ...config };
  const actionbarEvery = toIntervalTicks(cfg.actionbarHz);
  const chatEvery = toIntervalTicks(cfg.chatHz);
  const focusEvery = toIntervalTicks(cfg.focusHz);

  registerHeldProvider(ClockProvider);
  registerFocusProvider(PrismProvider);
  setFallbackProvider(FallbackProvider);

  system.runInterval(() => {
    const nowTick = system.currentTick;
    const players = world.getAllPlayers();
    const seen = new Set();
    const errorEntries = drainInsightErrors(nowTick, MAX_ERROR_MESSAGES_PER_TICK);
    const errorLines = errorEntries.map(formatInsightError).filter(Boolean);
    const errorChat = errorLines.length > 0 ? errorLines.join("\n") : "";
    let errorDelivered = false;

    for (const player of players) {
      if (!player?.id) continue;
      seen.add(player.id);

      const state = getInsightState(player);
      const held = getHeldInfo(player);
      const insightActive = computeInsightActive(player, held);
      const enhanced = insightActive && !!player.isSneaking;

      state.lastInsightActive = state.insightActive;
      state.lastEnhanced = state.enhanced;
      state.insightActive = insightActive;
      state.enhanced = enhanced;
      state.held = held;

      if (state.lastInsightActive !== state.insightActive) {
        showTitle(player, state.insightActive);
        state.lastChatHash = "";
        if (!state.insightActive) {
          try {
            player.onScreenDisplay?.setActionBar?.("");
          } catch {}
        }
      }
      if (state.lastEnhanced !== state.enhanced) {
        state.lastChatHash = "";
        if (!state.enhanced) {
          state.chatQueue = [];
          state.enhancedLastDumpTickByKey?.clear?.();
        }
      }

      if (errorChat && state.insightActive) {
        try {
          player.sendMessage(errorChat);
          errorDelivered = true;
        } catch {}
      }

      if (!state.insightActive) continue;

      if (nowTick % focusEvery === 0) {
        state.focus = focusScan(player, cfg.focusMaxDistance);
      }

      if (nowTick % actionbarEvery === 0) {
        const ctx = {
          player,
          nowTick,
          insightActive: state.insightActive,
          enhanced: state.enhanced,
          held: state.held,
          focus: state.focus,
          services: { world },
        };
        const provider = resolveProvider(ctx);
        const result = provider?.build?.(ctx);
        const line = result?.actionbarLine || "";
        if (line && line !== state.lastActionbarText) {
          try {
            player.onScreenDisplay?.setActionBar?.(line);
          } catch {}
          state.lastActionbarText = line;
        }
        state.provider = {
          id: provider?.id || null,
          contextKey: result?.contextKey || ctx.focus?.key || null,
          contextLabel: result?.contextLabel || provider?.id || "Insight",
          chatLines: Array.isArray(result?.chatLines) ? result.chatLines : [],
        };
      }

      if (nowTick % chatEvery === 0 && state.enhanced) {
        const contextKey = state.provider?.contextKey;
        const focus = state.focus;
        const hasInsightGear = isHoldingLens(player) || isWearingGoggles(player);
        const focusIsPrismBlock =
          focus &&
          focus.kind === "block" &&
          typeof focus.typeId === "string" &&
          focus.typeId.startsWith("chaos:prism_");
        const allowChatDump =
          state.provider?.id === "prism" &&
          !!contextKey &&
          hasInsightGear &&
          focusIsPrismBlock;

        if (allowChatDump) {
          const summary = getGlobalSummaryMessages();
          const messages = [
            ...summary,
            ...getGlobalMessages(),
            ...state.chatQueue,
          ];
          const deduped = dedupeMessages(messages);
          if (deduped.length > 0) {
            const limited = deduped.slice(0, MAX_CHAT_LINES);
            const hash = buildChatHash(limited);
            const history = state.enhancedLastDumpTickByKey;
            let lastDumpTick = -Infinity;
            if (history && typeof history.get === "function") {
              const recorded = history.get(contextKey);
              lastDumpTick = typeof recorded === "number" ? recorded : -Infinity;
            }
            const cooldownSatisfied = (nowTick - lastDumpTick) >= CHAT_DUMP_COOLDOWN;
            if (hash !== state.lastChatHash && cooldownSatisfied) {
              const formatted = formatBatch(getGlobalSummaryLabel(), limited);
              try {
                player.sendMessage(formatted);
              } catch {}
              state.lastChatHash = hash;
              if (history && typeof history.set === "function") {
                history.set(contextKey, nowTick);
                enforceMapLimit(history, MAX_CHAT_HISTORY);
              }
            }
          }
        }

        state.chatQueue = [];
      }
    }

    if (errorEntries.length > 0 && !errorDelivered) {
      requeueInsightErrors(errorEntries);
    }

    for (const [pid] of getAllInsightStates()) {
      if (!seen.has(pid)) removeInsightState(pid);
    }
  }, 1);
}
