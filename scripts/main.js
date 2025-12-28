import {
  BlockDynamicPropertiesDefinition,
  WorldDynamicPropertiesDefinition,
  world,
} from "@minecraft/server";
import { BlockIds, DynamicPropertyIds } from "./Constants.js";
import { initializeCrystalScheduler } from "./CrystalScheduler.js";
import { initializeNodeBinding } from "./NodeBinding.js";
import { initializeRegistryFromWorld } from "./Registry.js";

world.afterEvents.worldInitialize.subscribe((event) => {
  const worldProperties = new WorldDynamicPropertiesDefinition();
  worldProperties.defineString(DynamicPropertyIds.WorldCrystalList, 2048);
  event.propertyRegistry.registerWorldDynamicProperties(worldProperties);

  const nodeProperties = new BlockDynamicPropertiesDefinition();
  nodeProperties.defineString(DynamicPropertyIds.BoundCrystal, 64);
  nodeProperties.defineNumber(DynamicPropertyIds.AttachedFace);
  event.propertyRegistry.registerBlockTypeDynamicProperties(BlockIds.ChaosInputNode, nodeProperties);
  event.propertyRegistry.registerBlockTypeDynamicProperties(BlockIds.ChaosOutputNode, nodeProperties);

  const crystalProperties = new BlockDynamicPropertiesDefinition();
  crystalProperties.defineNumber(DynamicPropertyIds.InputCursor);
  crystalProperties.defineNumber(DynamicPropertyIds.OutputCursor);
  crystalProperties.defineString(DynamicPropertyIds.CrystalInputs, 2048);
  crystalProperties.defineString(DynamicPropertyIds.CrystalOutputs, 2048);
  event.propertyRegistry.registerBlockTypeDynamicProperties(BlockIds.ChaosCrystal, crystalProperties);

  initializeRegistryFromWorld();
});

initializeNodeBinding();
initializeCrystalScheduler();
