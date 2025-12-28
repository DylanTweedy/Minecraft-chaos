import { world } from "@minecraft/server";
import { DefaultBudgets, DynamicPropertyIds } from "./Constants.js";
import {
  canInsertItem,
  extractOne,
  findExtractableItem,
  getAttachedContainer,
  getFilterSet,
  insertOne,
} from "./ContainerUtils.js";
import { parseKey } from "./PositionUtils.js";
import {
  getCrystals,
  getCrystalEntry,
  resolveNodeBlock,
  unregisterCrystalByKey,
  unregisterNode,
  validateCrystal,
} from "./Registry.js";
import { spawnBeam } from "./Visuals.js";

function readCursor(block, propertyId) {
  const stored = block.getDynamicProperty(propertyId);
  if (typeof stored === "number" && Number.isInteger(stored)) {
    return stored;
  }
  return 0;
}

function writeCursor(block, propertyId, value) {
  block.setDynamicProperty(propertyId, value);
}

function findCrystalBlock(crystalKey) {
  const { location, dimensionId } = parseKey(crystalKey);
  const dimension = world.getDimension(dimensionId);
  if (!dimension) {
    return undefined;
  }
  return dimension.getBlock(location);
}

function resolveNode(nodeKey) {
  const { dimensionId } = parseKey(nodeKey);
  const dimension = world.getDimension(dimensionId);
  if (!dimension) {
    return undefined;
  }
  return resolveNodeBlock(dimension, nodeKey);
}

function removeInvalidNode(nodeKey) {
  unregisterNode(nodeKey);
  return undefined;
}

function tryTransfer(inputNodeKey, outputNodeKey) {
  const inputNode = resolveNode(inputNodeKey);
  const outputNode = resolveNode(outputNodeKey);
  if (!inputNode || !outputNode) {
    if (!inputNode) {
      removeInvalidNode(inputNodeKey);
    }
    if (!outputNode) {
      removeInvalidNode(outputNodeKey);
    }
    return false;
  }

  const inputFilter = getFilterSet(inputNode);
  const outputFilter = getFilterSet(outputNode);
  const inputContainer = getAttachedContainer(inputNode);
  const outputContainer = getAttachedContainer(outputNode);
  if (!inputContainer || !outputContainer) {
    return false;
  }

  const extractable = findExtractableItem(inputContainer, inputFilter);
  if (!extractable) {
    return false;
  }

  if (!canInsertItem(outputContainer, extractable.item, outputFilter)) {
    return false;
  }

  const extractedItem = extractOne(inputContainer, extractable.slot, extractable.item);
  if (!insertOne(outputContainer, extractedItem)) {
    inputContainer.setItem(extractable.slot, extractable.item);
    return false;
  }

  spawnBeam(inputNode.dimension, inputNode.location, outputNode.location);
  return true;
}

export function initializeCrystalScheduler() {
  world.afterEvents.tick.subscribe(() => {
    for (const [crystalKey] of getCrystals()) {
      const crystalBlock = findCrystalBlock(crystalKey);
      if (!validateCrystal(crystalBlock)) {
        unregisterCrystalByKey(crystalKey);
        continue;
      }
      const entry = getCrystalEntry(crystalKey);
      if (!entry || entry.inputs.length === 0 || entry.outputs.length === 0) {
        continue;
      }

      let inputCursor = readCursor(crystalBlock, DynamicPropertyIds.InputCursor);
      let outputCursor = readCursor(crystalBlock, DynamicPropertyIds.OutputCursor);

      let transfers = 0;
      let inputsChecked = 0;
      while (
        transfers < DefaultBudgets.TransfersPerTick &&
        inputsChecked < DefaultBudgets.InputChecksPerTick
      ) {
        if (entry.inputs.length === 0 || entry.outputs.length === 0) {
          break;
        }

        const inputIndex = inputCursor % entry.inputs.length;
        const inputNodeKey = entry.inputs[inputIndex];
        let transferred = false;
        for (let attempt = 0; attempt < DefaultBudgets.OutputsTriedPerInput; attempt += 1) {
          if (entry.outputs.length === 0) {
            break;
          }
          const outputIndex = (outputCursor + attempt) % entry.outputs.length;
          const outputNodeKey = entry.outputs[outputIndex];
          if (tryTransfer(inputNodeKey, outputNodeKey)) {
            transfers += 1;
            outputCursor = (outputIndex + 1) % entry.outputs.length;
            transferred = true;
            break;
          }
        }

        inputCursor = (inputIndex + 1) % entry.inputs.length;
        inputsChecked += 1;

        if (!transferred && inputsChecked >= DefaultBudgets.InputChecksPerTick) {
          break;
        }
      }

      writeCursor(crystalBlock, DynamicPropertyIds.InputCursor, inputCursor);
      writeCursor(crystalBlock, DynamicPropertyIds.OutputCursor, outputCursor);
    }
  });
}
