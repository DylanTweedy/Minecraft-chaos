// scripts/chaos/features/logistics/phases/08_movement/beamBreakDrops.js
import { parseKey } from "../../keys.js";
import { computeEdgePosition, dropItemAt } from "../../util/positions.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";
import { queueFxParticle } from "../../../../fx/fx.js";

export function dropOrbOnBrokenEdge(ctx, orb, edge, reason = "beam_break") {
  const parsedFrom = orb?.edgeFromKey ? parseKey(orb.edgeFromKey) : null;
  const parsedTo = orb?.edgeToKey ? parseKey(orb.edgeToKey) : null;
  const dim = ctx.services?.cacheManager?.getDimensionCached(parsedFrom?.dimId || null);
  if (!dim) return;
  const fromParsed = parsedFrom;
  if (!fromParsed) return;
  let dir = edge?.dir;
  let length = edge?.length;
  if (!dir && parsedFrom && parsedTo) {
    const dx = parsedTo.x - parsedFrom.x;
    const dy = parsedTo.y - parsedFrom.y;
    const dz = parsedTo.z - parsedFrom.z;
    dir = { dx: Math.sign(dx), dy: Math.sign(dy), dz: Math.sign(dz) };
    length = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  }
  if (!dir) dir = { dx: 0, dy: 0, dz: 0 };
  const maxLen = Math.max(1, length || orb.edgeLength || 1);
  // Drop rule: at computed position along the edge based on orb progress.
  const progress = Math.max(0, Math.min(maxLen, orb.progress || 0));
  const pos = computeEdgePosition(fromParsed, dir, progress);
  if (!pos) return;
  dropItemAt(dim, pos, orb.itemTypeId, orb.count);
  emitPrismReason(
    ctx,
    orb.edgeFromKey,
    ReasonCodes.EDGE_BROKEN_DROP,
    "Edge break: orb dropped in-flight",
    { itemTypeId: orb.itemTypeId }
  );
  const particleId = ctx.FX?.particleBeamUnpair || ctx.FX?.particleBeamOutputBurst;
  if (particleId) {
    queueFxParticle(dim, particleId, { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
  }
  bumpCounter(ctx, "dropped_on_break");
  bumpCounter(ctx, `dropped_${reason}`);
}






