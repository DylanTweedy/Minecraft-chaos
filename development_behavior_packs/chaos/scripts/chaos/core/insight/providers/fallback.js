// scripts/chaos/core/insight/providers/fallback.js

export const FallbackProvider = {
  id: "fallback",
  match() {
    return true;
  },
  build(ctx) {
    if (!ctx?.insightActive) return null;
    return {
      actionbarLine: "Insight: ON (crouch for details)",
      chatLines: ctx?.enhanced ? ["No context selected"] : [],
      contextLabel: "Insight",
    };
  },
};
