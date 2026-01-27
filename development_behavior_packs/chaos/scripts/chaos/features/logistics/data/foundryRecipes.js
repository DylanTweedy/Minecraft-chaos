// scripts/chaos/features/logistics/data/foundryRecipes.js

// Recipe entries:
// {
//   inputTypeId: "chaos:flux_1",
//   minLensCount: 0,
//   minSpeed: 0,
//   minHops: 0,
//   outputs: [{ typeId: "chaos:exotic_shard", amount: 1 }]
// }
//
// Leave empty by default; add recipes as needed.
export const FOUNDRY_RECIPES = [
  {
    inputTypeId: "chaos:flux_1",
    minLensCount: 0,
    minSpeed: 0,
    minHops: 0,
    outputs: [{ typeId: "chaos:exotic_shard", amount: 1 }],
  },
  {
    inputTypeId: "chaos:flux_2",
    minLensCount: 1,
    minSpeed: 0,
    minHops: 0,
    outputs: [{ typeId: "chaos:exotic_fiber", amount: 1 }],
  },
  {
    inputTypeId: "chaos:flux_3",
    minLensCount: 2,
    minSpeed: 0,
    minHops: 0,
    outputs: [{ typeId: "chaos:exotic_alloy_lump", amount: 1 }],
  },
  {
    inputTypeId: "chaos:flux_4",
    minLensCount: 3,
    minSpeed: 0,
    minHops: 0,
    outputs: [{ typeId: "chaos:chaos_crystal_shard", amount: 1 }],
  },
  {
    inputTypeId: "chaos:flux_5",
    minLensCount: 4,
    minSpeed: 0,
    minHops: 0,
    outputs: [{ typeId: "chaos:godsteel_ingot", amount: 1 }],
  },
];
