// scripts/chaos/core/insight/providers/crystallizer.js
import { getCrystalState } from "../../../crystallizer.js";

const CRYSTALLIZER_ID = "chaos:crystallizer";

function formatNumber(value) {
  const n = Math.max(0, Number(value) || 0);
  return Math.floor(n).toString();
}

export const CrystallizerProvider = {
  id: "crystallizer",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === CRYSTALLIZER_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const key = target?.prismKey || null;
    const state = key ? getCrystalState(key) : null;
    const stored = formatNumber(state?.fluxStored);
    const total = formatNumber(state?.fluxTotalLifetime);
    const level = Math.max(1, Number(state?.level) || 1);
    const prestige = Math.max(0, Number(state?.prestigeCount) || 0);

    const hudLine = `Crystallizer | Flux ${stored}`;
    const chatLines = [
      `Flux Stored ${stored}`,
      `Flux Total ${total}`,
      `Level ${level}`,
      `Prestige ${prestige}`,
    ];

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Crystallizer",
      severity: "Active",
      includeNetworkSummary: false,
    };
  },
};
