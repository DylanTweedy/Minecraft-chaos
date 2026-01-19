// scripts/chaos/core/insight/providers/clock.js

import { getPerfSnapshot } from "../perf.js";

function formatTime(ticks) {
  const t = ((ticks % 24000) + 24000) % 24000;
  const dayHours = (t / 1000 + 6) % 24;
  const hours = Math.floor(dayHours);
  const minutes = Math.floor((dayHours - hours) * 60);
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

export const ClockProvider = {
  id: "clock",
  match(ctx) {
    if (!ctx?.insightActive) return false;
    const target = ctx?.target;
    if (!target || target.type !== "item") return false;
    return target.id === "minecraft:clock";
  },
  build(ctx) {
    const target = ctx.target;
    const contextKey = target?.contextKey || null;
    const world = ctx?.services?.world;
    let timeTicks = 0;
    try {
      timeTicks = typeof world?.getTimeOfDay === "function" ? world.getTimeOfDay() : 0;
    } catch {
      timeTicks = 0;
    }
    const hudLine = `Clock ${formatTime(timeTicks)}`;

    const chatLines = [];
    if (ctx?.enhanced) {
      const perf = getPerfSnapshot("transfer");
      if (perf) {
        const tick = perf.tick || {};
        const scan = perf.scan || {};
        chatLines.push(
          `Transfer tick last=${tick.last?.toFixed?.(1) ?? tick.last ?? 0}ms avg=${tick.avg?.toFixed?.(1) ?? tick.avg ?? 0}ms`
        );
        chatLines.push(
          `Scan last=${scan.last?.toFixed?.(1) ?? scan.last ?? 0}ms avg=${scan.avg?.toFixed?.(1) ?? scan.avg ?? 0}ms`
        );
      } else {
        chatLines.push("Perf: TODO no samples yet");
      }
    }

    return {
      contextKey,
      hudLine,
      chatLines,
      contextLabel: "Clock",
    };
  },
};
