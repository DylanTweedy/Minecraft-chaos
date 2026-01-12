// scripts/chaos/features/links/transfer/runtime/phases/tickGuards.js

import { ok, phaseStep } from "../helpers/result.js";

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
    world,
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

        if ((consecutiveLongTicks % 10) === 0) {
          try {
            const players = world && typeof world.getAllPlayers === "function" ? world.getAllPlayers() : [];
            for (const player of players) {
              if (player && typeof player.sendMessage === "function") {
                player.sendMessage(
                  "¶õc[PERF] ƒsÿƒsÿƒsÿ EMERGENCY SKIP: " +
                    consecutiveLongTicks +
                    " consecutive long ticks detected, skipping tick " +
                    nowTick
                );
                break;
              }
            }
          } catch {}
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
