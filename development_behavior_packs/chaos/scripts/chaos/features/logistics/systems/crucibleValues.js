// scripts/chaos/features/logistics/systems/crucibleValues.js
import { ItemTypes } from "@minecraft/server";
import {
  CRUCIBLE_VALUE_DEFAULT,
  CRUCIBLE_VALUE_OVERRIDES,
} from "../data/crucibleValues.js";

let _valueMap = null;

function buildValueMap() {
  const map = new Map();
  try {
    const items = ItemTypes?.getAll?.() || [];
    for (const it of items) {
      const id = it?.id || it?.typeId;
      if (!id) continue;
      map.set(id, CRUCIBLE_VALUE_DEFAULT);
    }
  } catch {
    // ignore
  }

  for (const [id, val] of Object.entries(CRUCIBLE_VALUE_OVERRIDES || {})) {
    const n = Math.max(0, Number(val) || 0);
    map.set(id, n);
  }

  return map;
}

export function getCrucibleValueMap() {
  if (_valueMap) return _valueMap;
  _valueMap = buildValueMap();
  return _valueMap;
}

export function getCrucibleValue(typeId) {
  if (!typeId) return CRUCIBLE_VALUE_DEFAULT;
  const map = getCrucibleValueMap();
  if (!map) return CRUCIBLE_VALUE_DEFAULT;
  if (map.has(typeId)) return map.get(typeId) | 0;
  return CRUCIBLE_VALUE_DEFAULT;
}

export function refreshCrucibleValues() {
  _valueMap = buildValueMap();
  return _valueMap;
}
