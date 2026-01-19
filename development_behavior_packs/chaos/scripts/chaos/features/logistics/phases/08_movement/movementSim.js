// scripts/chaos/features/logistics/phases/08_movement/movementSim.js
import { OrbStates } from "../../state/enums.js";
import { dropOrbOnBrokenEdge } from "./beamBreakDrops.js";
import { bumpCounter } from "../../util/insightCounters.js";

export function advanceMovement(ctx) {
  const linkGraph = ctx.services?.linkGraph;
  const orbs = ctx.state?.orbs || [];
  if (!linkGraph) return;
  let moved = 0;
  const maxMoves = ctx.budgets.state.movements | 0;

  for (const orb of orbs) {
    if (moved >= maxMoves) break;
    if (!orb || orb.state !== OrbStates.IN_FLIGHT) continue;

    const edge = linkGraph?.getEdgeBetweenKeys(orb.edgeFromKey, orb.edgeToKey);
    if (!edge || (edge.epoch | 0) !== (orb.edgeEpoch | 0)) {
      dropOrbOnBrokenEdge(ctx, orb, edge, "beam_break");
      orb.state = null;
      orb._remove = true;
      moved++;
      continue;
    }

    const speed = Math.max(0.01, Number(orb.speed) || 1);
    orb.progress += speed;

    if (orb.progress >= (edge.length | 0)) {
      orb.state = OrbStates.AT_PRISM;
      orb.currentPrismKey = orb.edgeToKey;
      orb.progress = 0;
      ctx.arrivalQueue.push({ orbId: orb.id, prismKey: orb.edgeToKey });
      bumpCounter(ctx, "arrivals_movement");
    }

    moved++;
  }

  if (orbs.length > 0) {
    for (let i = orbs.length - 1; i >= 0; i--) {
      if (orbs[i]?._remove) {
        ctx.state.orbsById?.delete(orbs[i].id);
        orbs.splice(i, 1);
      }
    }
  }
}






