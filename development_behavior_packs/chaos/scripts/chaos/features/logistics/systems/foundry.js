// scripts/chaos/features/logistics/systems/foundry.js
import { FOUNDRY_RECIPES } from "../data/foundryRecipes.js";

function normalizeRecipes(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r === "object");
}

function matchesRecipe(recipe, ctx) {
  if (!recipe) return false;
  const inputTypeId = recipe.inputTypeId;
  if (inputTypeId && inputTypeId !== "*" && inputTypeId !== ctx.itemTypeId) return false;
  const minLens = Math.max(0, recipe.minLensCount | 0);
  const minSpeed = Math.max(0, Number(recipe.minSpeed) || 0);
  const minHops = Math.max(0, recipe.minHops | 0);
  if ((ctx.lensCount | 0) < minLens) return false;
  if ((ctx.speed || 0) < minSpeed) return false;
  if ((ctx.hops | 0) < minHops) return false;
  const outputs = Array.isArray(recipe.outputs) ? recipe.outputs : [];
  if (outputs.length === 0) return false;
  return true;
}

function resolveFirstMatch(recipes, ctx) {
  for (const recipe of recipes) {
    if (matchesRecipe(recipe, ctx)) return recipe;
  }
  return null;
}

export function resolveFoundryOutputs({ itemTypeId, count, lensCount, speed, hops } = {}) {
  const recipeList = normalizeRecipes(FOUNDRY_RECIPES);
  const ctx = {
    itemTypeId: String(itemTypeId || ""),
    count: Math.max(1, count | 0),
    lensCount: Math.max(0, lensCount | 0),
    speed: Number(speed) || 0,
    hops: Math.max(0, hops | 0),
  };
  const recipe = resolveFirstMatch(recipeList, ctx);
  if (!recipe) return null;

  const outputs = [];
  for (const entry of recipe.outputs) {
    if (!entry?.typeId) continue;
    const base = Math.max(0, entry.amount | 0);
    if (base <= 0) continue;
    outputs.push({ typeId: entry.typeId, amount: base * ctx.count });
  }

  if (outputs.length === 0) return null;
  return { outputs, recipe };
}
