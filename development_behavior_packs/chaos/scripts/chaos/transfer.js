// scripts/chaos/transfer.js
// Phase 2: budgeted, resilient item transfer loop.
// - NO DP access here
// - NO import-time world access
// - Safe failure semantics: never delete items on failure
// - Same-dimension only (skip cross-dimension outputs)

import { ItemStack } from "@minecraft/server";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

const DEFAULTS = {
  maxTransfersPerTick: 4,
  perInputIntervalTicks: 10,
  maxAltOutputTries: 2,
  transferAmount: 1,
};

function mergeCfg(defaults, opts) {
  const cfg = {};
  // copy defaults
  for (const k in defaults) cfg[k] = defaults[k];
  // copy opts
  if (opts) {
    for (const k2 in opts) cfg[k2] = opts[k2];
  }
  return cfg;
}

export function createTransferController(deps, opts) {
  const world = deps.world;
  const system = deps.system;
  const isPairsReady = deps.isPairsReady;
  const getPairsMap = deps.getPairsMap;
  const parseKey = deps.parseKey;
  const fxTransfer = deps.fxTransfer;
  const getSpeedForInput = deps.getSpeedForInput;

  const cfg = mergeCfg(DEFAULTS, opts);

  let cursor = 0;
  let tickId = null;

  // inputKey -> nextTickAllowed
  const nextAllowed = new Map();

  // monotonically increasing tick counter (local)
  let nowTick = 0;

  function safeBool(fn, fallback) {
    try {
      return !!fn();
    } catch (_) {
      return !!fallback;
    }
  }

  function safeGetPairs() {
    try {
      return getPairsMap();
    } catch (_) {
      return new Map();
    }
  }

  function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}
    return {
      intervalTicks: cfg.perInputIntervalTicks,
      amount: cfg.transferAmount,
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

    if (!safeBool(isPairsReady, false)) return;

    const pairsMap = safeGetPairs();
    if (!pairsMap || pairsMap.size === 0) return;

    // Snapshot keys for stable iteration this tick
    const inputKeys = [];
    try {
      for (const k of pairsMap.keys()) inputKeys.push(k);
    } catch (_) {
      return;
    }
    if (inputKeys.length === 0) return;

    let budget = cfg.maxTransfersPerTick;

    if (cursor >= inputKeys.length) cursor = 0;
    let scanned = 0;

    while (budget > 0 && scanned < inputKeys.length) {
      const inputKey = inputKeys[cursor];
      cursor = (cursor + 1) % inputKeys.length;
      scanned++;

      // Per-input throttle (no ??)
      const allowedAt = nextAllowed.has(inputKey) ? nextAllowed.get(inputKey) : 0;
      if (nowTick < allowedAt) continue;

      const didTransfer = safeAttemptTransferOne({
        world: world,
        parseKey: parseKey,
        pairsMap: pairsMap,
        inputKey: inputKey,
        fxTransfer: fxTransfer,
        maxAltTries: cfg.maxAltOutputTries,
        getSpeed: getSpeed,
      });

      const info = resolveInputBlockInfo(world, parseKey, inputKey);
      let interval = cfg.perInputIntervalTicks;
      if (info && info.block) {
        const s = getSpeed(info.block);
        interval = Math.max(1, (s && s.intervalTicks) ? s.intervalTicks : cfg.perInputIntervalTicks);
      }
      nextAllowed.set(inputKey, nowTick + interval);

      if (didTransfer) budget--;
    }
  }

  return { start, stop };
}

function resolveInputBlockInfo(world, parseKey, inputKey) {
  try {
    const pos = parseKey(inputKey);
    if (!pos) return null;

    const dim = world.getDimension(pos.dimId);
    if (!dim) return null;

    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;

    return { dim: dim, block: block, pos: pos };
  } catch (_) {
    return null;
  }
}

function resolveOutputBlockInfo(world, parseKey, outKey) {
  try {
    const pos = parseKey(outKey);
    if (!pos) return null;
    const dim = world.getDimension(pos.dimId);
    if (!dim) return null;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;
    return { dim: dim, block: block, pos: pos };
  } catch (_) {
    return null;
  }
}

function safeAttemptTransferOne(ctx) {
  try {
    const world = ctx.world;
    const parseKey = ctx.parseKey;
    const pairsMap = ctx.pairsMap;
    const inputKey = ctx.inputKey;
    const fxTransfer = ctx.fxTransfer;
    const maxAltTries = ctx.maxAltTries;
    const getSpeed = ctx.getSpeed;

    const inputInfo = resolveInputBlockInfo(world, parseKey, inputKey);
    if (!inputInfo) return false;

    const inDim = inputInfo.dim;
    const inBlock = inputInfo.block;
    if (!inBlock || inBlock.typeId !== INPUT_ID) return false;

    const speed = getSpeed(inBlock);
    const amount = Math.max(1, speed && speed.amount ? speed.amount : 1);

    const inContainer = getAttachedInventoryContainer(inBlock, inDim);
    if (!inContainer) return false;

    const pull = findFirstNonEmptySlot(inContainer);
    if (!pull) return false;

    const inSlot = pull.slot;
    const inStack = pull.stack;
    if (!inStack || inStack.amount <= 0) return false;

    const outputsSet = pairsMap.get(inputKey);
    if (!outputsSet || outputsSet.size === 0) return false;

    // same-dimension only
    const outputs = [];
    const inPos = safeParse(parseKey, inputKey);
    if (!inPos) return false;

    for (const outKey of outputsSet) {
      const outPos = safeParse(parseKey, outKey);
      if (!outPos) continue;
      if (outPos.dimId !== inPos.dimId) continue;
      outputs.push(outKey);
    }
    if (outputs.length === 0) return false;

    // Phase 1: move one item
    const toMove = 1;

    const one = cloneAsOne(inStack);

    // Remove from input first; rollback if no output accepts
    if (!decrementInputSlotSafe(inContainer, inSlot, inStack, toMove)) return false;

    const maxTries = Math.min(outputs.length, 1 + Math.max(0, maxAltTries));
    const tried = new Set();

    for (let attempt = 0; attempt < maxTries; attempt++) {
      const outKey = pickRandomUntried(outputs, tried);
      if (!outKey) break;
      tried.add(outKey);

      const outInfo = resolveOutputBlockInfo(world, parseKey, outKey);
      if (!outInfo) continue;

      const outDim = outInfo.dim;
      const outBlock = outInfo.block;
      if (!outBlock || outBlock.typeId !== OUTPUT_ID) continue;

      const outContainer = getAttachedInventoryContainer(outBlock, outDim);
      if (!outContainer) continue;

      const ok = tryInsertOne(outContainer, one);
      if (!ok) continue;

      try {
        if (typeof fxTransfer === "function") fxTransfer(inBlock, outBlock, one.typeId);
      } catch (_) {}

      return true;
    }

    restoreInputSlotBestEffort(inContainer, inSlot, inStack);
    return false;
  } catch (_) {
    return false;
  }
}

function safeParse(parseKey, key) {
  try { return parseKey(key); } catch (_) { return null; }
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

    // block_face
    try {
      const face = perm.getState("minecraft:block_face");
      if (typeof face === "string") return face;
    } catch (_) {}

    // facing_direction -> opposite
    try {
      const fd = perm.getState("minecraft:facing_direction");
      if (typeof fd === "number") {
        const front = numFacingToDir(fd);
        return oppositeDir(front);
      }
    } catch (_) {}

    // cardinal_direction -> opposite
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

function restoreInputSlotBestEffort(container, slot, originalStack) {
  try { container.setItem(slot, originalStack); } catch (_) {}
}

function pickRandomUntried(arr, triedSet) {
  try {
    const candidates = [];
    for (const v of arr) if (!triedSet.has(v)) candidates.push(v);
    if (candidates.length === 0) return null;
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  } catch (_) {
    return null;
  }
}

function tryInsertOne(container, oneStack) {
  try {
    if (!container || !oneStack) return false;

    const size = container.size;
    const typeId = oneStack.typeId;

    // 1) stack onto existing
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

    // 2) first empty
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
