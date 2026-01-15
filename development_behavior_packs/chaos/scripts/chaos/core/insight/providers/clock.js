// scripts/chaos/core/insight/providers/clock.js

import { getPerfSnapshot } from "../perf.js";

function formatTime(ticks) {
  const t = ((ticks % 24000) + 24000) % 24000;
  const dayHours = (t / 1000 + 6) % 24;
  const hours = Math.floor(dayHours);
  const minutes = Math.floor(((dayHours - hours) * 60));
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

export const ClockProvider = {
  id: "clock",
  match(ctx) {
    if (!ctx?.insightActive) return false;
    const typeId = ctx?.held?.typeId;
    return typeId === "minecraft:clock";
  },
  build(ctx) {
    const world = ctx?.services?.world;
    let timeTicks = 0;
    try {
      timeTicks = typeof world?.getTimeOfDay === "function" ? world.getTimeOfDay() : 0;
    } catch {
      timeTicks = 0;
    }
    const actionbarLine = `Clock ${formatTime(timeTicks)}`;

    const chatLines = [];
    if (ctx?.enhanced) {
      const perf = getPerfSnapshot("transfer");
      if (perf) {
        const tick = perf.tick || {};
        const scan = perf.scan || {};
        chatLines.push(`Transfer tick last=${(tick.last || 0).toFixed ? (tick.last || 0).toFixed(1) : tick.last}ms avg=${(tick.avg || 0).toFixed ? tick.avg.toFixed(1) : tick.avg}ms`);
        chatLines.push(`Scan last=${(scan.last || 0).toFixed ? (scan.last || 0).toFixed(1) : scan.last}ms avg=${(scan.avg || 0).toFixed ? scan.avg.toFixed(1) : scan.avg}ms`);
      } else {
        chatLines.push("Perf: TODO no samples yet");
      }
    }

    return {
      actionbarLine,
      chatLines,
      contextLabel: "Clock",
    };
  },
};
