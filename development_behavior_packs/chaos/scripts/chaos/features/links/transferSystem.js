// scripts/chaos/features/links/transferSystem.js
// Network transfer system using beam graph pathing.

import { ItemStack, MolangVariableMap } from "@minecraft/server";
import { MAX_BEAM_LEN } from "./beamConfig.js";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const PRISM_ID = "chaos:prism";
const BEAM_ID = "chaos:beam";
const DP_BEAMS = "chaos:beams_v0_json";
const MAX_STEPS = MAX_BEAM_LEN * 12;

const DEFAULTS = {
  maxTransfersPerTick: 4,
  perInputIntervalTicks: 10,
  cacheTicks: 10,
  orbStepTicks: 20,
};

function mergeCfg(defaults, opts) {
  const cfg = {};
  for (const k in defaults) cfg[k] = defaults[k];
  if (opts) {
    for (const k2 in opts) cfg[k2] = opts[k2];
  }
  return cfg;
}

function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

function parseKey(k) {
  try {
    if (typeof k !== "string") return null;
    const p = k.indexOf("|");
    if (p <= 0) return null;
    const dimId = k.slice(0, p);
    const rest = k.slice(p + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { dimId, x: x | 0, y: y | 0, z: z | 0 };
  } catch {
    return null;
  }
}

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadBeamsMap(world) {
  try {
    const raw = world.getDynamicProperty(DP_BEAMS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function getNodeType(id) {
  if (id === INPUT_ID) return "input";
  if (id === OUTPUT_ID) return "output";
  if (id === PRISM_ID) return "prism";
  return null;
}

function scanEdgeFromNode(dim, loc, dir) {
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
      if (path.length === 0) return null;
      return {
        nodeType,
        nodePos: { x, y, z },
        path: path,
      };
    }

    break;
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

export function createTransferPathfinder(deps, opts) {
  const world = deps.world;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);
  const cache = new Map();

  function invalidateInput(inputKey) {
    cache.delete(inputKey);
  }

  function findPathForInput(inputKey, nowTick) {
    const stamp = (typeof getNetworkStamp === "function") ? getNetworkStamp() : null;
    const cached = cache.get(inputKey);
    if (cached) {
      const okTick = (nowTick - cached.tick) <= cfg.cacheTicks;
      const okStamp = (stamp == null || stamp === cached.stamp);
      if (okTick && okStamp) return cached.path;
    }

    const parsed = parseKey(inputKey);
    if (!parsed) {
      cache.set(inputKey, { tick: nowTick, stamp, path: null });
      return null;
    }

    const dim = world.getDimension(parsed.dimId);
    if (!dim) {
      cache.set(inputKey, { tick: nowTick, stamp, path: null });
      return null;
    }

    const startBlock = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!startBlock || startBlock.typeId !== INPUT_ID) {
      cache.set(inputKey, { tick: nowTick, stamp, path: null });
      return null;
    }

    const visited = new Set();
    const queue = [];
    queue.push({
      nodePos: { x: parsed.x, y: parsed.y, z: parsed.z },
      nodeType: "input",
      path: [],
    });
    visited.add(key(parsed.dimId, parsed.x, parsed.y, parsed.z));

    const dirs = makeDirs();
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;

      for (const d of dirs) {
        const edge = scanEdgeFromNode(dim, cur.nodePos, d);
        if (!edge) continue;

        if (cur.nodeType === "input" && edge.nodeType === "input") continue;
        if (cur.nodeType === "prism" && edge.nodeType === "input") continue;
        if (cur.nodeType === "output") continue;

        const nextKey = key(parsed.dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
        if (visited.has(nextKey)) continue;

        const nextPath = cur.path.concat(edge.path, [edge.nodePos]);

        if (edge.nodeType === "output") {
          const result = {
            dimId: parsed.dimId,
            outputKey: nextKey,
            outputPos: edge.nodePos,
            path: nextPath,
          };
          cache.set(inputKey, { tick: nowTick, stamp, path: result });
          return result;
        }

        visited.add(nextKey);
        queue.push({
          nodePos: edge.nodePos,
          nodeType: edge.nodeType,
          path: nextPath,
        });
      }
    }

    cache.set(inputKey, { tick: nowTick, stamp, path: null });
    return null;
  }

  return { findPathForInput, invalidateInput };
}

export function createNetworkTransferController(deps, opts) {
  const world = deps.world;
  const system = deps.system;
  const FX = deps.FX;
  const getSpeedForInput = deps.getSpeedForInput;
  const findPathForInput = deps.findPathForInput;
  const invalidateInput = deps.invalidateInput;

  const cfg = mergeCfg(DEFAULTS, opts);

  let cursor = 0;
  let tickId = null;
  let nowTick = 0;

  const nextAllowed = new Map();
  const inflight = [];

  function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}
    return {
      intervalTicks: cfg.perInputIntervalTicks,
      amount: 1,
    };
  }

  function start() {
    if (tickId !== null) return;
    tickId = system.runInterval(onTick, 1);
  }

  function stop() {
    if (tickId === null) return;
    try { system.clearRun(tickId); } catch (_) {}
    tickId = null;
  }

  function onTick() {
    nowTick++;

    tickInFlight();

    const map = loadBeamsMap(world);
    const inputKeys = Object.keys(map);
    if (inputKeys.length === 0) return;

    if (cursor >= inputKeys.length) cursor = 0;
    let scanned = 0;
    let budget = cfg.maxTransfersPerTick;

    while (budget > 0 && scanned < inputKeys.length) {
      const inputKey = inputKeys[cursor];
      cursor = (cursor + 1) % inputKeys.length;
      scanned++;

      const allowedAt = nextAllowed.has(inputKey) ? nextAllowed.get(inputKey) : 0;
      if (nowTick < allowedAt) continue;

      const didTransfer = attemptTransferOne(inputKey);

      const info = resolveBlockInfo(inputKey);
      let interval = cfg.perInputIntervalTicks;
      if (info && info.block) {
        const s = getSpeed(info.block);
        interval = Math.max(1, (s && s.intervalTicks) ? s.intervalTicks : cfg.perInputIntervalTicks);
      }
      nextAllowed.set(inputKey, nowTick + interval);

      if (didTransfer) budget--;
    }
  }

  function resolveBlockInfo(inputKey) {
    try {
      const pos = parseKey(inputKey);
      if (!pos) return null;
      const dim = world.getDimension(pos.dimId);
      if (!dim) return null;
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) return null;
      return { dim, block, pos };
    } catch {
      return null;
    }
  }

  function attemptTransferOne(inputKey) {
    const inputInfo = resolveBlockInfo(inputKey);
    if (!inputInfo) return false;

    const inDim = inputInfo.dim;
    const inBlock = inputInfo.block;
    if (!inBlock || inBlock.typeId !== INPUT_ID) return false;

    const inContainer = getAttachedInventoryContainer(inBlock, inDim);
    if (!inContainer) return false;

    const pull = findFirstNonEmptySlot(inContainer);
    if (!pull) return false;

    const inSlot = pull.slot;
    const inStack = pull.stack;
    if (!inStack || inStack.amount <= 0) return false;

    const pathInfo = (typeof findPathForInput === "function")
      ? findPathForInput(inputKey, nowTick)
      : null;
    if (!pathInfo || !Array.isArray(pathInfo.path) || pathInfo.path.length === 0) return false;
    if (pathInfo.path.length > MAX_STEPS) return false;

    const dim = inputInfo.dim;
    if (!dim) return false;

    if (!validatePathStart(dim, pathInfo.path)) {
      if (typeof invalidateInput === "function") invalidateInput(inputKey);
      const fresh = findPathForInput ? findPathForInput(inputKey, nowTick) : null;
      if (!fresh || !Array.isArray(fresh.path) || fresh.path.length === 0) return false;
      if (!validatePathStart(dim, fresh.path)) return false;
      pathInfo.path = fresh.path;
      pathInfo.outputKey = fresh.outputKey;
    }
    if (pathInfo.path.length > MAX_STEPS) return false;

    const outInfo = resolveBlockInfo(pathInfo.outputKey);
    if (!outInfo) return false;

    const outBlock = outInfo.block;
    if (!outBlock || outBlock.typeId !== OUTPUT_ID) return false;

    const outContainer = getAttachedInventoryContainer(outBlock, outInfo.dim);
    if (!outContainer) return false;

    if (!canInsertOne(outContainer, inStack.typeId)) return false;

    if (!spawnOrbStep(inDim, inBlock.location, pathInfo.path[0])) return false;

    const current = inContainer.getItem(inSlot);
    if (!current || current.typeId !== inStack.typeId || current.amount <= 0) return false;

    if (!decrementInputSlotSafe(inContainer, inSlot, current, 1)) return false;

    inflight.push({
      dimId: inputInfo.pos.dimId,
      itemTypeId: inStack.typeId,
      path: pathInfo.path,
      stepIndex: 0,
      ticksUntilStep: cfg.orbStepTicks,
      outputKey: pathInfo.outputKey,
    });

    return true;
  }

  function tickInFlight() {
    if (inflight.length === 0) return;

    for (let i = inflight.length - 1; i >= 0; i--) {
      const job = inflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        finalizeJob(job);
        inflight.splice(i, 1);
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const dim = world.getDimension(job.dimId);
      if (!dim) {
        inflight.splice(i, 1);
        continue;
      }

      spawnOrbStep(dim, cur, next);
      job.stepIndex = nextIdx;
      job.ticksUntilStep = cfg.orbStepTicks;
    }
  }

  function finalizeJob(job) {
    const outInfo = resolveBlockInfo(job.outputKey);
    if (!outInfo) return;

    const outBlock = outInfo.block;
    if (!outBlock || outBlock.typeId !== OUTPUT_ID) return;

    const outContainer = getAttachedInventoryContainer(outBlock, outInfo.dim);
    if (outContainer && tryInsertOne(outContainer, new ItemStack(job.itemTypeId, 1))) return;

    dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId);
  }

  function spawnOrbStep(dim, from, to) {
    try {
      if (!FX || !FX.particleTransferItem) return false;
      const fxId = FX.particleTransferItem;
      const dir = normalizeDir(from, to);
      if (!dir) return false;

      const molang = new MolangVariableMap();
      const speed = 1.0;
      if (typeof molang.setSpeedAndDirection === "function") {
        molang.setSpeedAndDirection("variable.chaos_move", speed, dir);
      }
      molang.setFloat("variable.chaos_move.speed", speed);
      molang.setFloat("variable.chaos_move.direction_x", dir.x);
      molang.setFloat("variable.chaos_move.direction_y", dir.y);
      molang.setFloat("variable.chaos_move.direction_z", dir.z);

      const pos = {
        x: from.x + 0.5,
        y: from.y + 0.5,
        z: from.z + 0.5,
      };
      dim.spawnParticle(fxId, pos, molang);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(len) || len <= 0.0001) return null;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  function dropItemAt(dim, loc, typeId) {
    try {
      const dropLoc = findDropLocation(dim, loc);
      dim.spawnItem(new ItemStack(typeId, 1), dropLoc);
    } catch {
      // ignore
    }
  }

  return { start, stop };
}

function validatePathStart(dim, path) {
  const checks = Math.min(2, path.length);
  for (let i = 0; i < checks; i++) {
    const p = path[i];
    const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
    if (!b || b.typeId !== BEAM_ID) return false;
  }
  return true;
}

function findDropLocation(dim, loc) {
  const candidates = [
    { x: loc.x, y: loc.y + 1, z: loc.z },
    { x: loc.x + 1, y: loc.y, z: loc.z },
    { x: loc.x - 1, y: loc.y, z: loc.z },
    { x: loc.x, y: loc.y, z: loc.z + 1 },
    { x: loc.x, y: loc.y, z: loc.z - 1 },
  ];
  for (const c of candidates) {
    const b = dim.getBlock(c);
    if (b && b.typeId === "minecraft:air") {
      return { x: c.x + 0.5, y: c.y + 0.1, z: c.z + 0.5 };
    }
  }
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function getAttachedInventoryContainer(nodeBlock, dimension) {
  try {
    const attachedDir = getAttachedDirectionFromStates(nodeBlock);
    if (attachedDir) {
      const adj = getNeighborBlock(nodeBlock, dimension, attachedDir);
      const c = getInventoryContainer(adj);
      if (c) return c;
    }

    const dirs = ["north", "south", "east", "west", "up", "down"];
    const hits = [];
    for (const d of dirs) {
      const adj = getNeighborBlock(nodeBlock, dimension, d);
      const c = getInventoryContainer(adj);
      if (c) hits.push(c);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return hits[0];
    return null;
  } catch (_) {
    return null;
  }
}

function getAttachedDirectionFromStates(block) {
  try {
    const perm = block.permutation;
    if (!perm) return null;

    try {
      const face = perm.getState("minecraft:block_face");
      if (typeof face === "string") return face;
    } catch (_) {}

    try {
      const fd = perm.getState("minecraft:facing_direction");
      if (typeof fd === "number") {
        const front = numFacingToDir(fd);
        return oppositeDir(front);
      }
    } catch (_) {}

    try {
      const cd = perm.getState("minecraft:cardinal_direction");
      if (typeof cd === "string") return oppositeDir(cd);
    } catch (_) {}

    return null;
  } catch (_) {
    return null;
  }
}

function numFacingToDir(n) {
  switch (n) {
    case 0: return "down";
    case 1: return "up";
    case 2: return "north";
    case 3: return "south";
    case 4: return "west";
    case 5: return "east";
    default: return null;
  }
}

function oppositeDir(dir) {
  switch (dir) {
    case "north": return "south";
    case "south": return "north";
    case "east": return "west";
    case "west": return "east";
    case "up": return "down";
    case "down": return "up";
    default: return null;
  }
}

function getNeighborBlock(block, dimension, dir) {
  try {
    if (!block || !dimension) return null;
    const loc = block.location;
    let nx = loc.x, ny = loc.y, nz = loc.z;
    switch (dir) {
      case "north": nz -= 1; break;
      case "south": nz += 1; break;
      case "west": nx -= 1; break;
      case "east": nx += 1; break;
      case "down": ny -= 1; break;
      case "up": ny += 1; break;
      default: return null;
    }
    return dimension.getBlock({ x: nx, y: ny, z: nz });
  } catch (_) {
    return null;
  }
}

function getInventoryContainer(block) {
  try {
    if (!block) return null;
    const inv = block.getComponent("minecraft:inventory");
    if (!inv) return null;
    const c = inv.container;
    return c || null;
  } catch (_) {
    return null;
  }
}

function findFirstNonEmptySlot(container) {
  try {
    const size = container.size;
    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (it && it.amount > 0) return { slot: i, stack: it };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function decrementInputSlotSafe(container, slot, originalStack, count) {
  try {
    if (!container || !originalStack) return false;
    if (originalStack.amount < count) return false;

    if (originalStack.amount === count) {
      return clearSlotSafe(container, slot);
    } else {
      const dec = (typeof originalStack.clone === "function") ? originalStack.clone() : cloneAsOne(originalStack);
      dec.amount = originalStack.amount - count;
      try {
        container.setItem(slot, dec);
        return true;
      } catch (_) {
        return false;
      }
    }
  } catch (_) {
    return false;
  }
}

function clearSlotSafe(container, slot) {
  try {
    try { container.setItem(slot, undefined); return true; } catch (_) {}
    try { container.setItem(slot, null); return true; } catch (_) {}
    try { container.setItem(slot); return true; } catch (_) {}
    return false;
  } catch (_) {
    return false;
  }
}

function cloneAsOne(stack) {
  try {
    if (typeof stack.clone === "function") {
      const c = stack.clone();
      c.amount = 1;
      return c;
    }
  } catch (_) {}

  try {
    return new ItemStack(stack.typeId, 1);
  } catch (_) {
    return stack;
  }
}

function canInsertOne(container, typeId) {
  try {
    const size = container.size;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;
      const max = it.maxAmount || 64;
      if (it.amount < max) return true;
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (!it2) return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

function tryInsertOne(container, oneStack) {
  try {
    if (!container || !oneStack) return false;

    const size = container.size;
    const typeId = oneStack.typeId;

    for (let i = 0; i < size; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;

      const max = it.maxAmount || 64;
      if (it.amount >= max) continue;

      const next = (typeof it.clone === "function") ? it.clone() : it;
      next.amount = Math.min(max, it.amount + 1);

      try {
        container.setItem(i, next);
        return true;
      } catch (_) {}
    }

    for (let j = 0; j < size; j++) {
      const it2 = container.getItem(j);
      if (it2) continue;
      try {
        container.setItem(j, oneStack);
        return true;
      } catch (_) {}
    }

    return false;
  } catch (_) {
    return false;
  }
}
