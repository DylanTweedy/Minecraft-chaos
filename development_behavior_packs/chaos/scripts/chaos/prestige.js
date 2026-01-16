// scripts/chaos/prestige.js
import { world, system, ItemStack } from "@minecraft/server";
import { makeKey } from "./features/links/network/keys.js";
import { MAX_BEAM_LEN } from "./features/links/network/beams/beamConfig.js";
import { queueFxParticle } from "./fx/fx.js";
import { FX } from "./fx/fxConfig.js";
import {
  CRYSTAL_TAG,
  CRYS_KEY_TAG_PREFIX,
  getCrystalState,
  setCrystalState,
  parseKey,
  resolveBlockForKey,
} from "./crystallizer.js";
import { isPrismBlock, getPrismTier, getPrismTypeIdForTier } from "./features/links/transfer/config.js";

const CRYSTALLIZER_ID = "chaos:crystallizer";
const BEAM_ID = "chaos:beam";

const DP_INPUT_LEVELS = "chaos:input_levels_v0_json";
const DP_OUTPUT_LEVELS = "chaos:output_levels_v0_json";
const DP_PRISM_LEVELS = "chaos:prism_levels_v0_json";

const MAX_NETWORK_NODES = 512;
const REWARD_RATIO = 0.25;
const REWARD_CAP = 256;
const PRESTIGE_COOLDOWN_TICKS = 6;

const lastPrestigeTickByKey = new Map();

function safeJsonParse(raw, fallback) {
  try {
    if (typeof raw !== "string" || !raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

function getCrystalKeyFromEntity(entity) {
  try {
    if (!entity?.hasTag?.(CRYSTAL_TAG)) return null;
    const tags = entity.getTags?.();
    if (!Array.isArray(tags)) return null;
    for (const tag of tags) {
      if (typeof tag === "string" && tag.startsWith(CRYS_KEY_TAG_PREFIX)) {
        return tag.slice(CRYS_KEY_TAG_PREFIX.length);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function makeDirs() {
  return [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
}

function getNodeType(id) {
  // Unified system - only prisms and crystallizers
  if (id && isPrismBlock({ typeId: id })) return "prism";
  if (id === CRYSTALLIZER_ID) return "crystal";
  return null;
}

function allowAdjacentNode(curType, nodeType) {
  // All prisms and crystallizers can connect
  if (curType === "prism" || nodeType === "prism") return true;
  if (curType === "crystal" || nodeType === "crystal") return true;
  return false;
}

function scanEdgeFromNode(dim, loc, dir, curNodeType) {
  const path = [];
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dir.dx * i;
    const y = loc.y + dir.dy * i;
    const z = loc.z + dir.dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === BEAM_ID) {
      path.push({ x, y, z });
      continue;
    }

    const nodeType = getNodeType(id);
    if (nodeType) {
      if (path.length === 0 && !allowAdjacentNode(curNodeType, nodeType)) return null;
      return { nodeType, nodePos: { x, y, z }, path };
    }

    break;
  }
  return null;
}

function getAdjacentStartNodes(block) {
  const dim = block?.dimension;
  if (!dim) return [];
  const loc = block.location;
  const nodes = [];
  if (block.typeId === CRYSTALLIZER_ID) {
    nodes.push({ nodeType: "crystal", nodePos: { x: loc.x, y: loc.y, z: loc.z } });
  }
  for (const d of makeDirs()) {
    const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
    const type = getNodeType(b?.typeId);
    if (!type) continue;
    nodes.push({ nodeType: type, nodePos: b.location });
  }
  return nodes;
}

function traverseNetworkFromStart(dim, dimId, startNodes) {
  const inputs = new Set();
  const outputs = new Set();
  const prisms = new Set();
  const visited = new Set();
  const queue = [];
  let qIndex = 0;

  for (const s of startNodes) {
    const key = makeKey(dimId, s.nodePos.x, s.nodePos.y, s.nodePos.z);
    if (visited.has(key)) continue;
    visited.add(key);
    queue.push(s);
    if (s.nodeType === "input") inputs.add(key);
    else if (s.nodeType === "output") outputs.add(key);
    else if (s.nodeType === "prism") prisms.add(key);
  }

  while (qIndex < queue.length) {
    if (visited.size >= MAX_NETWORK_NODES) break;
    const cur = queue[qIndex++];
    const dirs = makeDirs();
    for (const d of dirs) {
      const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
      if (!edge) continue;
      const key = makeKey(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push(edge);
      if (edge.nodeType === "input") inputs.add(key);
      else if (edge.nodeType === "output") outputs.add(key);
      else if (edge.nodeType === "prism") prisms.add(key);
      if (visited.size >= MAX_NETWORK_NODES) break;
    }
  }

  return { inputs, outputs, prisms };
}

function setTierToOne(block) {
  try {
    if (!block) return false;
    // New system: prisms use separate block IDs, not states
    // Replace block with tier 1 prism if it's a higher tier
    if (!isPrismBlock(block)) return false;
    const currentTier = getPrismTier(block);
    if (currentTier === 1) return true; // Already tier 1
    const tierOneId = getPrismTypeIdForTier(1);
    const loc = block.location;
    const dim = block.dimension;
    if (!dim || !loc) return false;
    dim.setBlock(loc, tierOneId);
    return true;
  } catch {
    return false;
  }
}

function resetCountsForKeys(dpKey, keys) {
  try {
    const raw = world.getDynamicProperty(dpKey);
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") return;
    let changed = false;
    for (const key of keys) {
      if (parsed[key] != null) {
        delete parsed[key];
        changed = true;
      }
    }
    if (!changed) return;
    const out = safeJsonStringify(parsed);
    if (typeof out !== "string") return;
    world.setDynamicProperty(dpKey, out);
  } catch {
    // ignore
  }
}

function tryInsertAmount(container, typeId, amount) {
  try {
    if (!container || !typeId) return false;
    let remaining = Math.max(1, amount | 0);
    if (remaining <= 0) return true;

    const probe = new ItemStack(typeId, 1);
    const maxStack = probe.maxAmount || 64;
    const size = container.size;

    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it || it.typeId !== typeId) continue;
      const max = it.maxAmount || maxStack;
      if (it.amount >= max) continue;

      const add = Math.min(max - it.amount, remaining);
      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = it.amount + add;
      try {
        container.setItem(i, next);
        remaining -= add;
      } catch {}
    }

    for (let j = 0; j < size && remaining > 0; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      const add = Math.min(maxStack, remaining);
      try {
        container.setItem(j, new ItemStack(typeId, add));
        remaining -= add;
      } catch {}
    }

    return remaining <= 0;
  } catch {
    return false;
  }
}

function dropFlux(dim, loc, amount) {
  try {
    if (!dim || !loc || amount <= 0) return;
    let remaining = Math.max(1, amount | 0);
    let maxStack = 64;
    try {
      const probe = new ItemStack("chaos:flux_1", 1);
      maxStack = probe.maxAmount || 64;
    } catch {}
    while (remaining > 0) {
      const n = Math.min(maxStack, remaining);
      dim.spawnItem(new ItemStack("chaos:flux_1", n), loc);
      remaining -= n;
    }
  } catch {
    // ignore
  }
}

function getCrystalDropPos(entity, block) {
  if (entity) {
    const loc = entity.location;
    return { x: loc.x, y: loc.y, z: loc.z };
  }
  const loc = block.location;
  return { x: loc.x + 0.5, y: loc.y + 1.2, z: loc.z + 0.5 };
}

function performPrestige(player, entity, crystalKey) {
  const parsed = parseKey(crystalKey);
  if (!parsed) return;
  const dim = world.getDimension(parsed.dimId);
  if (!dim) return;

  const now = system.currentTick;
  const last = lastPrestigeTickByKey.get(crystalKey) ?? -9999;
  if ((now - last) < PRESTIGE_COOLDOWN_TICKS) return;
  lastPrestigeTickByKey.set(crystalKey, now);

  const block = resolveBlockForKey(crystalKey);
  if (!block) return;

  const startNodes = getAdjacentStartNodes(block);
  const network = traverseNetworkFromStart(dim, parsed.dimId, startNodes);

  // Unified system - all nodes are prisms
  for (const key of network.inputs) {
    const b = resolveBlockForKey(key);
    if (b && isPrismBlock(b)) setTierToOne(b);
  }
  for (const key of network.outputs) {
    const b = resolveBlockForKey(key);
    if (b && isPrismBlock(b)) setTierToOne(b);
  }
  for (const key of network.prisms) {
    const b = resolveBlockForKey(key);
    if (b && isPrismBlock(b)) setTierToOne(b);
  }

  resetCountsForKeys(DP_INPUT_LEVELS, network.inputs);
  resetCountsForKeys(DP_OUTPUT_LEVELS, network.outputs);
  resetCountsForKeys(DP_PRISM_LEVELS, network.prisms);

  const state = getCrystalState(crystalKey);
  const stored = Math.max(0, Number(state?.fluxStored) || 0);
  const reward = Math.min(REWARD_CAP, Math.floor(stored * REWARD_RATIO));

  if (reward > 0) {
    const inv = block.getComponent("minecraft:inventory")?.container || null;
    const dropPos = getCrystalDropPos(entity, block);
    const inserted = inv ? tryInsertAmount(inv, "chaos:flux_1", reward) : false;
    if (!inserted) dropFlux(dim, dropPos, reward);
  }

  state.fluxStored = 0;
  state.prestigeCount = Math.max(0, (state.prestigeCount | 0) + 1);
  setCrystalState(crystalKey, state);

  const fxPos = getCrystalDropPos(entity, block);
  queueFxParticle(dim, FX?.particleFluxGenerate, fxPos);
  try {
    player?.playSound?.("random.levelup", { location: fxPos });
  } catch {
    // ignore
  }
}

export function startPrestigeSystem() {
  const handler = (ev) => {
    try {
      const target = ev?.target ?? ev?.entity ?? ev?.interactedEntity;
      if (!target) return;
      const key = getCrystalKeyFromEntity(target);
      if (!key) return;
      const player = ev?.player ?? ev?.source;
      if (!player || player.typeId !== "minecraft:player") return;
      performPrestige(player, target, key);
    } catch {
      // ignore
    }
  };

  try {
    world.afterEvents.playerInteractWithEntity.subscribe(handler);
  } catch {
    // ignore
  }
}
