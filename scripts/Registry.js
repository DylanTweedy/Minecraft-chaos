import { world } from "@minecraft/server";
import { BlockIds, DynamicPropertyIds } from "./Constants.js";
import { parseKey, serializeKey } from "./PositionUtils.js";

const crystals = new Map();
const nodes = new Map();
let registryInitialized = false;

function readJsonList(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeJsonList(list) {
  return JSON.stringify(list);
}

function ensureCrystalEntry(crystalKey) {
  let entry = crystals.get(crystalKey);
  if (!entry) {
    entry = {
      inputs: [],
      outputs: [],
    };
    crystals.set(crystalKey, entry);
  }
  return entry;
}

function getCrystalBlockFromKey(crystalKey) {
  const { location, dimensionId } = parseKey(crystalKey);
  const dimension = world.getDimension(dimensionId);
  if (!dimension) {
    return undefined;
  }
  return dimension.getBlock(location);
}

function getWorldCrystalList() {
  const stored = world.getDynamicProperty(DynamicPropertyIds.WorldCrystalList);
  return readJsonList(stored);
}

function setWorldCrystalList(list) {
  world.setDynamicProperty(DynamicPropertyIds.WorldCrystalList, writeJsonList(list));
}

function addCrystalToWorldList(crystalKey) {
  const list = getWorldCrystalList();
  if (!list.includes(crystalKey)) {
    list.push(crystalKey);
    setWorldCrystalList(list);
  }
}

function removeCrystalFromWorldList(crystalKey) {
  const list = getWorldCrystalList().filter((key) => key !== crystalKey);
  setWorldCrystalList(list);
}

function readCrystalNodeList(crystalBlock, propertyId) {
  if (!crystalBlock) {
    return [];
  }
  const stored = crystalBlock.getDynamicProperty(propertyId);
  return readJsonList(stored);
}

function writeCrystalNodeList(crystalBlock, propertyId, list) {
  if (!crystalBlock) {
    return;
  }
  crystalBlock.setDynamicProperty(propertyId, writeJsonList(list));
}

function writeCrystalLists(crystalKey, entry) {
  const crystalBlock = getCrystalBlockFromKey(crystalKey);
  if (!crystalBlock || crystalBlock.typeId !== BlockIds.ChaosCrystal) {
    return;
  }
  writeCrystalNodeList(crystalBlock, DynamicPropertyIds.CrystalInputs, entry.inputs);
  writeCrystalNodeList(crystalBlock, DynamicPropertyIds.CrystalOutputs, entry.outputs);
}

export function registerCrystal(block) {
  const crystalKey = serializeKey(block.location, block.dimension.id);
  ensureCrystalEntry(crystalKey);
  addCrystalToWorldList(crystalKey);
  return crystalKey;
}

export function unregisterCrystal(block) {
  const crystalKey = serializeKey(block.location, block.dimension.id);
  return unregisterCrystalByKey(crystalKey);
}

export function unregisterCrystalByKey(crystalKey) {
  const entry = crystals.get(crystalKey);
  if (entry) {
    entry.inputs.forEach((key) => nodes.delete(key));
    entry.outputs.forEach((key) => nodes.delete(key));
  }
  crystals.delete(crystalKey);
  removeCrystalFromWorldList(crystalKey);
  return crystalKey;
}

export function registerNode(nodeKey, crystalKey, nodeType) {
  const entry = ensureCrystalEntry(crystalKey);
  if (nodeType === BlockIds.ChaosInputNode) {
    if (!entry.inputs.includes(nodeKey)) {
      entry.inputs.push(nodeKey);
    }
  } else if (nodeType === BlockIds.ChaosOutputNode) {
    if (!entry.outputs.includes(nodeKey)) {
      entry.outputs.push(nodeKey);
    }
  }

  nodes.set(nodeKey, { crystalKey, nodeType });
  writeCrystalLists(crystalKey, entry);
}

export function unregisterNode(nodeKey) {
  const nodeEntry = nodes.get(nodeKey);
  if (!nodeEntry) {
    return;
  }
  const crystalEntry = crystals.get(nodeEntry.crystalKey);
  if (crystalEntry) {
    if (nodeEntry.nodeType === BlockIds.ChaosInputNode) {
      crystalEntry.inputs = crystalEntry.inputs.filter((key) => key !== nodeKey);
    } else if (nodeEntry.nodeType === BlockIds.ChaosOutputNode) {
      crystalEntry.outputs = crystalEntry.outputs.filter((key) => key !== nodeKey);
    }
    writeCrystalLists(nodeEntry.crystalKey, crystalEntry);
  }
  nodes.delete(nodeKey);
}

export function rebindNode(nodeKey, newCrystalKey, nodeType) {
  unregisterNode(nodeKey);
  registerNode(nodeKey, newCrystalKey, nodeType);
}

export function getCrystals() {
  return crystals;
}

export function getNodeEntry(nodeKey) {
  return nodes.get(nodeKey);
}

export function getCrystalEntry(crystalKey) {
  return crystals.get(crystalKey);
}

export function validateCrystal(block) {
  return block && block.typeId === BlockIds.ChaosCrystal;
}

export function resolveNodeBlock(dimension, nodeKey) {
  const { location } = parseKey(nodeKey);
  return dimension.getBlock(location);
}

export function initializeRegistryFromWorld() {
  if (registryInitialized) {
    return;
  }
  registryInitialized = true;
  const crystalKeys = getWorldCrystalList();
  const validCrystals = [];
  crystalKeys.forEach((crystalKey) => {
    const crystalBlock = getCrystalBlockFromKey(crystalKey);
    if (!crystalBlock || crystalBlock.typeId !== BlockIds.ChaosCrystal) {
      return;
    }

    const entry = ensureCrystalEntry(crystalKey);
    const inputKeys = readCrystalNodeList(crystalBlock, DynamicPropertyIds.CrystalInputs);
    const outputKeys = readCrystalNodeList(crystalBlock, DynamicPropertyIds.CrystalOutputs);
    const filteredInputs = [];
    const filteredOutputs = [];

    inputKeys.forEach((nodeKey) => {
      const nodeBlock = getCrystalBlockFromKey(nodeKey);
      if (nodeBlock && nodeBlock.typeId === BlockIds.ChaosInputNode) {
        filteredInputs.push(nodeKey);
        nodes.set(nodeKey, { crystalKey, nodeType: BlockIds.ChaosInputNode });
      }
    });

    outputKeys.forEach((nodeKey) => {
      const nodeBlock = getCrystalBlockFromKey(nodeKey);
      if (nodeBlock && nodeBlock.typeId === BlockIds.ChaosOutputNode) {
        filteredOutputs.push(nodeKey);
        nodes.set(nodeKey, { crystalKey, nodeType: BlockIds.ChaosOutputNode });
      }
    });

    entry.inputs = filteredInputs;
    entry.outputs = filteredOutputs;
    writeCrystalLists(crystalKey, entry);
    validCrystals.push(crystalKey);
  });

  setWorldCrystalList(validCrystals);
}
