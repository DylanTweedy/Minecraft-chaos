// scripts/chaos/features/logistics/phases/08_movement/beamBreakDrops.js
import { parseKey } from "../../keys.js";
import { computeEdgePosition, dropItemAt } from "../../util/positions.js";
import { bumpCounter } from "../../util/insightCounters.js";

export function dropOrbOnBrokenEdge(ctx, orb, edge, reason = "beam_break") {
  const dim = ctx.services?.cacheManager?.getDimensionCached(orb?.edgeFromKey ? parseKey(orb.edgeFromKey)?.dimId : null);
  if (!dim) return;
  const fromParsed = parseKey(orb.edgeFromKey);
  if (!fromParsed) return;
  const dir = edge?.dir || { dx: 0, dy: 0, dz: 0 };
  const progress = Math.max(0, Math.min(edge?.length || 1, orb.progress || 0));
  const pos = computeEdgePosition(fromParsed, dir, progress);
  if (!pos) return;
  dropItemAt(dim, pos, orb.itemTypeId, orb.count);
  bumpCounter(ctx, "dropped_on_break");
  bumpCounter(ctx, `dropped_${reason}`);
}






