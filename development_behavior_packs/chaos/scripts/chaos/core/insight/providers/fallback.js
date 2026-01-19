// scripts/chaos/core/insight/providers/fallback.js

const TIP_COOLDOWN = 200;
const TIP_HISTORY_LIMIT = 64;
const tipHistory = new Map();

function recordTip(contextKey, tick) {
  if (!contextKey) return;
  tipHistory.set(contextKey, tick);
  if (tipHistory.size > TIP_HISTORY_LIMIT) {
    const oldest = tipHistory.keys().next().value;
    if (oldest) tipHistory.delete(oldest);
  }
}

function canEmitTip(contextKey, nowTick) {
  if (!contextKey || !Number.isFinite(nowTick)) return false;
  const last = tipHistory.get(contextKey);
  if (typeof last === "number" && nowTick - last < TIP_COOLDOWN) {
    return false;
  }
  return true;
}

export const FallbackProvider = {
  id: "fallback",
  match(ctx) {
    return !!ctx?.target;
  },
  build(ctx) {
    if (!ctx?.target) return null;
    const contextKey = ctx.target.contextKey || null;
    const chatLines = [];
    if (ctx?.enhanced && contextKey) {
      const nowTick = ctx?.nowTick | 0;
      if (canEmitTip(contextKey, nowTick)) {
        chatLines.push("Insight tip: focus a block, entity, or item for details.");
        recordTip(contextKey, nowTick);
      }
    }
    return {
      contextKey,
      hudLine: "",
      chatLines,
      contextLabel: "Insight",
    };
  },
};
