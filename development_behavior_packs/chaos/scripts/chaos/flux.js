// scripts/chaos/flux.js
import { ItemStack } from "@minecraft/server";
import { getOutputTier, getPrismTier } from "./tiers.js";
import { fxFluxGenerate, fxFluxRefine, fxFluxMutate, fxFluxOrbStep } from "./fx/fx.js";

export const FLUX_IDS = [
  "chaos:flux_1",
  "chaos:flux_2",
  "chaos:flux_3",
  "chaos:flux_4",
  "chaos:flux_5",
];

export const EXOTIC_IDS = [
  "chaos:exotic_shard",
  "chaos:exotic_fiber",
  "chaos:exotic_alloy_lump",
];

const FLUX_TIER_BY_ID = new Map(FLUX_IDS.map((id, i) => [id, i + 1]));

const OUTPUT_FLUX_CHANCE = [0.01, 0.02, 0.04, 0.07, 0.1];
const OUTPUT_FLUX_DOUBLE_CHANCE_L5 = 0.03;

const PRISM_REFINE_CHANCE = [0.10, 0.18, 0.30, 0.45, 0.65];
const PRISM_MUTATION_CHANCE = [0.0005, 0.0010, 0.0020, 0.0035, 0.0060];
const MAX_REFINE_CHECKS_PER_TRANSFER = 8;

const EXOTIC_WEIGHTS = [
  { id: "chaos:exotic_shard", w: 70 },
  { id: "chaos:exotic_fiber", w: 25 },
  { id: "chaos:exotic_alloy_lump", w: 5 },
];

export function isFluxTypeId(typeId) {
  return FLUX_TIER_BY_ID.has(typeId);
}

export function getFluxTier(typeId) {
  return FLUX_TIER_BY_ID.get(typeId) || 0;
}

export function getFluxTypeForTier(tier) {
  const t = Math.max(1, Math.min(5, tier | 0));
  return FLUX_IDS[t - 1];
}

function pickWeightedExotic() {
  let total = 0;
  for (const entry of EXOTIC_WEIGHTS) total += entry.w;
  let roll = Math.random() * total;
  for (const entry of EXOTIC_WEIGHTS) {
    roll -= entry.w;
    if (roll <= 0) return entry.id;
  }
  return EXOTIC_WEIGHTS[0].id;
}

function tryInsertAmount(container, typeId, amount) {
  try {
    if (!container || !typeId) return false;
    let remaining = Math.max(1, amount | 0);
    if (remaining <= 0) return false;

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

function dropItemAt(dim, loc, typeId, amount) {
  try {
    if (!dim || !loc) return;
    const amt = Math.max(1, amount | 0);
    let remaining = amt;
    let maxStack = 64;
    try {
      const probe = new ItemStack(typeId, 1);
      maxStack = probe.maxAmount || 64;
    } catch {}
    while (remaining > 0) {
      const n = Math.min(maxStack, remaining);
      dim.spawnItem(new ItemStack(typeId, n), {
        x: loc.x + 0.5,
        y: loc.y + 0.5,
        z: loc.z + 0.5,
      });
      remaining -= n;
    }
  } catch {
    // ignore
  }
}

function getBlockInventory(block) {
  try {
    const inv = block?.getComponent?.("minecraft:inventory");
    return inv?.container || null;
  } catch {
    return null;
  }
}

function sameBlockPos(a, b) {
  if (!a || !b) return false;
  const al = a.location;
  const bl = b.location;
  return al && bl && al.x === bl.x && al.y === bl.y && al.z === bl.z;
}

function findPathIndex(fullPath, targetBlock) {
  if (!targetBlock) return -1;
  for (let i = 0; i < fullPath.length; i++) {
    if (sameBlockPos(fullPath[i], targetBlock)) return i;
  }
  return -1;
}

function findFluxTargetFromPath(fullPath, outputBlock, getAttachedInventoryInfo, dim) {
  if (!Array.isArray(fullPath) || fullPath.length === 0) return null;
  const outputIndex = findPathIndex(fullPath, outputBlock);
  if (outputIndex < 0) return null;

  for (let i = outputIndex - 1; i >= 0; i--) {
    const block = fullPath[i];
    if (!block) continue;
    const info = (typeof getAttachedInventoryInfo === "function")
      ? getAttachedInventoryInfo(block, dim)
      : null;
    const inv = info?.container || getBlockInventory(block);
    if (inv) return { block, inventory: inv };
  }
  return null;
}

export function depositFluxIntoInventory(container, itemStack) {
  try {
    if (!container || !itemStack) return false;
    return tryInsertAmount(container, itemStack.typeId, itemStack.amount);
  } catch {
    return false;
  }
}

export function tryGenerateFluxOnTransfer(ctx) {
  try {
    const outputBlock = ctx?.outputBlock;
    if (!outputBlock) return 0;

    const tier = getOutputTier(outputBlock);
    const chance = OUTPUT_FLUX_CHANCE[tier - 1] || 0;
    if (Math.random() >= chance) return 0;

    let amount = 1;
    if (tier >= 5 && Math.random() < OUTPUT_FLUX_DOUBLE_CHANCE_L5) {
      amount = 2;
    }

    const fluxStack = new ItemStack(FLUX_IDS[0], amount);
    const fluxTier = getFluxTier(fluxStack.typeId);
    const destInv = ctx?.destinationInventory;
    const dim = outputBlock.dimension;

    const path = Array.isArray(ctx?.path) ? ctx.path : [];
    const pathBlocks = [];
    for (const p of path) {
      const b = dim?.getBlock?.({ x: p.x, y: p.y, z: p.z });
      if (b) pathBlocks.push(b);
    }
    const inputBlock = ctx?.inputBlock;
    const fullPath = inputBlock ? [inputBlock, ...pathBlocks] : pathBlocks;

    const target = findFluxTargetFromPath(fullPath, outputBlock, ctx?.getAttachedInventoryInfo, dim);
    const targetBlock = target?.block || null;
    const targetIndex = findPathIndex(fullPath, targetBlock);
    const outputIndex = findPathIndex(fullPath, outputBlock);

    const scheduleFx = (typeof ctx?.scheduleFluxTransferFx === "function");
    let scheduled = false;
    if (scheduleFx && outputIndex >= 0 && targetIndex >= 0 && outputIndex > targetIndex && target?.inventory) {
      const containerKey = (typeof ctx?.getContainerKey === "function")
        ? ctx.getContainerKey(targetBlock)
        : null;
      ctx.scheduleFluxTransferFx(fullPath, outputIndex, targetIndex, fluxStack.typeId, ctx?.transferLevel, {
        containerKey,
        amount: fluxStack.amount,
        dropPos: targetBlock?.location || outputBlock.location,
      });
      scheduled = true;
    } else if (outputIndex >= 0 && targetIndex >= 0 && outputIndex > targetIndex) {
      for (let i = outputIndex; i > targetIndex; i--) {
        const fromBlock = fullPath[i];
        const toBlock = fullPath[i - 1];
        if (fromBlock && toBlock) fxFluxOrbStep(fromBlock, toBlock, ctx?.FX, fluxTier);
      }
    } else if (targetBlock && outputBlock) {
      fxFluxOrbStep(outputBlock, targetBlock, ctx?.FX, fluxTier);
    }

    let deposited = false;
    if (!scheduled && target?.inventory) deposited = depositFluxIntoInventory(target.inventory, fluxStack);
    if (!scheduled && !deposited && destInv) deposited = depositFluxIntoInventory(destInv, fluxStack);
    if (!scheduled && !deposited) dropItemAt(outputBlock.dimension, outputBlock.location, fluxStack.typeId, fluxStack.amount);

    fxFluxGenerate(outputBlock, ctx?.FX);
    return amount;
  } catch {
    return 0;
  }
}

export function tryRefineFluxInTransfer(ctx) {
  try {
    const prismBlock = ctx?.prismBlock;
    if (!prismBlock) return null;

    const typeId = ctx?.itemTypeId;
    const amount = Math.max(1, ctx?.amount | 0);
    if (!isFluxTypeId(typeId)) return null;

    const tier = getPrismTier(prismBlock);
    const refineChance = PRISM_REFINE_CHANCE[tier - 1] || 0;
    const mutationChance = PRISM_MUTATION_CHANCE[tier - 1] || 0;

    let refined = 0;
    let mutated = 0;
    let refinedTypeId = null;
    let mutatedTypeId = null;
    const results = new Map();

    const checks = Math.max(1, Math.min(amount, MAX_REFINE_CHECKS_PER_TRANSFER));
    for (let i = 0; i < amount; i++) {
      let outType = typeId;
      if (i < checks) {
        const curTier = getFluxTier(outType);
        if (curTier > 0 && curTier < 5 && Math.random() < refineChance) {
          refined++;
          outType = getFluxTypeForTier(curTier + 1);
          if (!refinedTypeId) refinedTypeId = outType;
          if (Math.random() < mutationChance) {
            mutated++;
            outType = pickWeightedExotic();
            if (!mutatedTypeId) mutatedTypeId = outType;
          }
        }
      }
      const prev = results.get(outType) || 0;
      results.set(outType, prev + 1);
    }

    if (refined > 0) fxFluxRefine(prismBlock, ctx?.FX, refinedTypeId);
    if (mutated > 0) fxFluxMutate(prismBlock, ctx?.FX, mutatedTypeId);

    return {
      items: Array.from(results.entries()).map(([id, n]) => ({ typeId: id, amount: n })),
      refined,
      mutated,
    };
  } catch {
    return null;
  }
}
