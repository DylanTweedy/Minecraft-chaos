// scripts/chaos/features/links/beam/storage.js
import { DP_BEAMS } from "./config.js";

export function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

export function parseKey(k) {
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

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// Migrate old map format to new format (one-time conversion)
function migrateBeamsMap(world, map) {
  let migrated = false;
  const migratedMap = {};
  
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    
    // Create new entry with only connections structure
    const newEntry = {
      dimId: entry.dimId,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      kind: entry.kind || "prism",
      connections: Array.isArray(entry.connections) ? entry.connections : []
    };
    
    // Remove old beams/rays arrays - they're no longer stored
    if (Array.isArray(entry.beams) || Array.isArray(entry.rays)) {
      migrated = true;
    }
    
    migratedMap[key] = newEntry;
  }
  
  if (migrated) {
    saveBeamsMap(world, migratedMap);
  }
  
  return migrated ? migratedMap : map;
}

export function loadBeamsMap(world) {
  try {
    const raw = world.getDynamicProperty(DP_BEAMS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    
    // Migrate old format to new format (one-time)
    return migrateBeamsMap(world, parsed);
  } catch {
    return {};
  }
}

export function saveBeamsMap(world, map) {
  try {
    const raw = safeJsonStringify(map);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_BEAMS, raw);
  } catch {
    // ignore
  }
}

export function getDimensionById(world, dimId) {
  try {
    return world.getDimension(dimId);
  } catch {
    return null;
  }
}
