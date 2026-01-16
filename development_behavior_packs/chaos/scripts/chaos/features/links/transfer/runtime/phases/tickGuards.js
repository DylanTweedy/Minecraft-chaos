// scripts/chaos/features/links/transfer/runtime/phases/tickGuards.js

import { ok, phaseStep } from "../../util/result.js";

export function createTickGuardsPhase(deps) {
  const handler = createTickGuardsHandler(deps);

  return {
    name: "tickGuards",
    run(ctx) {
      phaseStep(ctx, "tickGuards");
      return handler(ctx);
    },
  };
}

function createTickGuardsHandler(deps) {
  const {
    getNowTick,
    getLastTickEndTime,
    setLastTickEndTime,
    getConsecutiveLongTicks,
    setConsecutiveLongTicks,
  } = deps || {};

  return function runTickGuards(ctx) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : (ctx?.nowTick | 0);
    const lastTickEndTime =
      typeof getLastTickEndTime === "function" ? getLastTickEndTime() : 0;
    let consecutiveLongTicks =
      typeof getConsecutiveLongTicks === "function" ? (getConsecutiveLongTicks() | 0) : 0;

    if (lastTickEndTime > 0) {
      const timeSinceLastTick = Date.now() - lastTickEndTime;

      if (timeSinceLastTick > 50 && consecutiveLongTicks > 2) {
        consecutiveLongTicks++;
        if (typeof setConsecutiveLongTicks === "function") {
          setConsecutiveLongTicks(consecutiveLongTicks);
        }
        if ((consecutiveLongTicks % 10) === 0 && typeof ctx?.noteWatchdog === "function") {
          ctx.noteWatchdog(
            "EMERGENCY",
            `Skip tick ${nowTick} after ${consecutiveLongTicks} long ticks`,
            nowTick
          );
        }

        if (typeof setLastTickEndTime === "function") {
          setLastTickEndTime(Date.now());
        }

        return { ...ok(), stop: true, reason: "skip_tick" };
      }
    }

    return ok();
  };
}

