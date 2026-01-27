// scripts/chaos/core/insight/providers/transposer.js
import { getLinkedKey } from "../../../features/transposer/pairs.js";
import { parseKey } from "../../../features/logistics/keys.js";
import { getChargeLimits, getSharedStateKey, getSharedStateSnapshot } from "../../../features/transposer/state.js";

const TRANSPOSER_ID = "chaos:teleporter";

function formatPos(parsed) {
  if (!parsed) return "unknown";
  return `${parsed.dimId} ${parsed.x},${parsed.y},${parsed.z}`;
}

function getBlockAt(world, dimId, pos) {
  try {
    if (!world || !dimId || !pos) return null;
    const dim = world.getDimension(dimId);
    if (!dim) return null;
    return dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
  } catch {
    return null;
  }
}

function formatDistance(a, b) {
  if (!a || !b) return "n/a";
  if (a.dimId !== b.dimId) return "n/a (cross-dimension)";
  const dx = (a.x | 0) - (b.x | 0);
  const dy = (a.y | 0) - (b.y | 0);
  const dz = (a.z | 0) - (b.z | 0);
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
}

export const TransposerProvider = {
  id: "transposer",
  match(ctx) {
    const target = ctx?.target;
    return !!target && target.type === "block" && target.id === TRANSPOSER_ID;
  },
  build(ctx) {
    const target = ctx?.target;
    if (!target) return null;
    const world = ctx?.services?.world;
    const key = target?.prismKey || null;
    const linked = key ? getLinkedKey(key) : null;
    const linkedParsed = linked ? parseKey(linked) : null;
    const linkedBlock = linkedParsed
      ? getBlockAt(world, linkedParsed.dimId, linkedParsed)
      : null;
    const linkedOk = !!linkedBlock && linkedBlock.typeId === TRANSPOSER_ID;

    const status = linked
      ? (linkedOk ? "LINKED" : (linkedParsed ? "LINKED_MISSING" : "LINKED_UNLOADED"))
      : "UNLINKED";

    const sharedKey = getSharedStateKey(key, linked);
    const state = sharedKey ? getSharedStateSnapshot(sharedKey) : null;
    const charge = Math.max(0, state?.charge | 0);
    const { max: chargeMax } = getChargeLimits();
    const nowTick = ctx?.nowTick | 0;
    const lastTeleportTick = Math.max(0, state?.lastTeleportTick | 0);
    const lastCooldown = Math.max(0, state?.lastTeleportCooldown | 0);
    const cooldownRemaining = Math.max(0, lastCooldown - Math.max(0, (nowTick | 0) - lastTeleportTick));

    const hudLine = linked
      ? `Transposer | ${status} | Charge ${charge}`
      : "Transposer | UNLINKED";

    let ready = linkedOk && charge > 0;
    let reason = "";
    if (!linked) reason = "NO_LINK";
    else if (!linkedOk) reason = "DEST_INVALID";
    else if (cooldownRemaining > 0) reason = "COOLDOWN";
    else if (charge <= 0) reason = "NO_CHARGE";
    else ready = true;

    const chatLines = [
      `Block: Transposer`,
      `This end: ${formatPos(parseKey(key))}`,
      linked ? `Linked end: ${formatPos(linkedParsed)}` : "Linked end: Unlinked",
      `Status: ${status}`,
      `Distance: ${linked ? formatDistance(parseKey(key), linkedParsed) : "n/a"}`,
      `Shared charge: ${charge} / ${chargeMax}`,
      `Overcharge enabled: true`,
      `Cost: player/NPC = 1 flux, item = 0`,
      `Ready: ${ready ? "YES" : "NO"}${ready ? "" : ` (${reason})`}`,
      `Cooldown remaining: ${cooldownRemaining > 0 ? `${cooldownRemaining} ticks` : "0"}`,
      `Last teleport: ${lastTeleportTick > 0 ? `${Math.max(0, (nowTick | 0) - lastTeleportTick)} ticks ago` : "never"}`,
      `Lifetime teleports: players=${state?.lifetime?.players | 0} entities=${state?.lifetime?.entities | 0} items=${state?.lifetime?.items | 0}`,
      `Failed attempts: NO_LINK=${state?.failed?.NO_LINK | 0} NO_CHARGE=${state?.failed?.NO_CHARGE | 0} COOLDOWN=${state?.failed?.COOLDOWN | 0} DEST_INVALID=${state?.failed?.DEST_INVALID | 0}`,
    ];

    return {
      contextKey: target?.contextKey || null,
      hudLine,
      chatLines,
      contextLabel: "Transposer",
    };
  },
};
