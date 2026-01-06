// scripts/chaos/beamSim.js
import { world, system, BlockPermutation } from "@minecraft/server";
import { MAX_BEAM_LEN } from "./beamConfig.js";
import { bumpNetworkStamp } from "./networkStamp.js";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const PRISM_ID = "chaos:prism";
const BEAM_ID = "chaos:beam";
const INPUTS_PER_TICK = 1;
const RELAYS_PER_TICK = 1;
const VALIDATIONS_PER_TICK = 12;
const TICK_INTERVAL = 1;

// Beam block supports axis states (now x/y/z)
const AXIS_X = "x";
const AXIS_Y = "y";
const AXIS_Z = "z";

// Persistent storage (best-effort; no DynamicPropertiesDefinition)
const DP_BEAMS = "chaos:beams_v0_json";

// Placement settle window (bounded, event-seeded; NOT polling/scanning)
const EMIT_RETRY_TICKS = 4;

const PASS_THROUGH_IDS = new Set(["minecraft:air", BEAM_ID, OUTPUT_ID]);

// -----------------------------------------------------------------------------
// Persistent model
// -----------------------------------------------------------------------------
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

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function loadBeamsMap() {
  try {
    const raw = world.getDynamicProperty(DP_BEAMS);
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveBeamsMap(map) {
  try {
    const raw = safeJsonStringify(map);
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_BEAMS, raw);
  } catch {
    // ignore
  }
}

function getDimensionById(dimId) {
  try {
    return world.getDimension(dimId);
  } catch {
    return null;
  }
}

// IMPORTANT: axis mapping is SWAPPED to match authored geometry for horizontal.
// - Rays along +/-X need axis "z"
// - Rays along +/-Z need axis "x"
// Vertical rays use "y".
function axisForDir(dx, dy, dz) {
  if (dy !== 0) return AXIS_Y;

  // horizontal swap to match your model
  if (Math.abs(dx) > Math.abs(dz)) return AXIS_Z; // X-direction -> "z"
  if (Math.abs(dz) > Math.abs(dx)) return AXIS_X; // Z-direction -> "x"
  return AXIS_X;
}

function beamDirsForAxis(axis) {
  if (axis === AXIS_Y) return [{ dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: -1, dz: 0 }];
  if (axis === AXIS_X) return [{ dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 }];
  if (axis === AXIS_Z) return [{ dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 }];
  return [{ dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 }];
}

function isPassThrough(id) {
  return PASS_THROUGH_IDS.has(id);
}

function getBeamAxis(block) {
  try {
    const axis = block?.permutation?.getState("chaos:axis");
    if (axis === AXIS_X || axis === AXIS_Y || axis === AXIS_Z) return axis;
  } catch {
    // ignore
  }
  return AXIS_X;
}

function beamAxisMatchesDir(block, dx, dy, dz) {
  const axis = getBeamAxis(block);
  return axis === axisForDir(dx, dy, dz);
}

function prismHasDirectSource(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
    if (!b) continue;
    if (b.typeId === BEAM_ID && beamAxisMatchesDir(b, d.dx, d.dy, d.dz)) return true;
    if (b.typeId === INPUT_ID || b.typeId === OUTPUT_ID) return true;
  }
  return false;
}

function prismHasRelaySource(dim, loc) {
  if (prismHasDirectSource(dim, loc)) return true;

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const b = dim.getBlock({ x: loc.x + d.dx, y: loc.y + d.dy, z: loc.z + d.dz });
    if (b?.typeId !== PRISM_ID) continue;
    if (prismHasDirectSource(dim, b.location)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Queues (budgeted per tick)
// -----------------------------------------------------------------------------
const pendingInputs = [];
const pendingInputsSet = new Set();

const pendingRelays = [];
const pendingRelaysSet = new Set();

const pendingValidations = [];
const pendingValidationsSet = new Set();

function enqueueInputForRescan(inputKey) {
  if (!inputKey) return;
  if (pendingInputsSet.has(inputKey)) return;
  pendingInputsSet.add(inputKey);
  pendingInputs.push(inputKey);
}

function enqueueBeamValidation(beamKey) {
  if (!beamKey) return;
  if (pendingValidationsSet.has(beamKey)) return;
  pendingValidationsSet.add(beamKey);
  pendingValidations.push(beamKey);
}

function enqueueRelayForRescan(prismKey) {
  if (!prismKey) return;
  if (pendingRelaysSet.has(prismKey)) return;
  pendingRelaysSet.add(prismKey);
  pendingRelays.push(prismKey);
}

function enqueueAdjacentBeams(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const x = loc.x + d.dx;
    const y = loc.y + d.dy;
    const z = loc.z + d.dz;
    const b = dim.getBlock({ x, y, z });
    if (b?.typeId === BEAM_ID) {
      enqueueBeamValidation(key(dim.id, x, y, z));
    }
  }
}

function enqueueAdjacentPrisms(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    const x = loc.x + d.dx;
    const y = loc.y + d.dy;
    const z = loc.z + d.dz;
    const b = dim.getBlock({ x, y, z });
    if (b?.typeId === PRISM_ID) {
      enqueueRelayForRescan(key(dim.id, x, y, z));
    }
  }
}

function enqueueBeamsInLine(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const b = dim.getBlock({ x, y, z });
      if (!b) break;
      const id = b.typeId;
      if (id === BEAM_ID) {
        enqueueBeamValidation(key(dim.id, x, y, z));
        continue;
      }
      if (id === OUTPUT_ID) continue;
      if (id === PRISM_ID) break;
      if (id === "minecraft:air") break;
      break;
    }
  }
}

function clearBeamsFromBreak(dim, loc) {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const b = dim.getBlock({ x, y, z });
      if (!b) break;
      const id = b.typeId;
      if (id === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, { x, y, z });
        enqueueAdjacentPrisms(dim, { x, y, z });
        continue;
      }
      if (id === "minecraft:air") break;
      if (id === OUTPUT_ID) break;
      if (id === INPUT_ID) break;
      if (id === PRISM_ID) break;
      break;
    }
  }
}

// -----------------------------------------------------------------------------
// Beam placement helpers
// -----------------------------------------------------------------------------
function placeBeamIfAir(dim, x, y, z, axis) {
  try {
    const b = dim.getBlock({ x, y, z });
    if (!b || b.typeId !== "minecraft:air") return false;

    const safeAxis = (axis === AXIS_Y ? AXIS_Y : (axis === AXIS_Z ? AXIS_Z : AXIS_X));
    const perm = BlockPermutation.resolve(BEAM_ID, { "chaos:axis": safeAxis });
    b.setPermutation(perm);
    return true;
  } catch {
    return false;
  }
}

function removeRecordedBeams(entry) {
  try {
    const dim = getDimensionById(entry?.dimId);
    if (!dim) return;

    const recorded = Array.isArray(entry?.beams) ? entry.beams : [];
      for (const bk of recorded) {
        const p = parseKey(bk);
        if (!p) continue;
        if (p.dimId !== entry.dimId) continue;
        const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
        if (b?.typeId === BEAM_ID) {
          b.setType("minecraft:air");
          enqueueAdjacentBeams(dim, p);
          enqueueAdjacentPrisms(dim, p);
        }
      }

    // legacy cleanup (rays.blocks)
    const rays = Array.isArray(entry?.rays) ? entry.rays : [];
    for (const r of rays) {
      const blocks = Array.isArray(r?.blocks) ? r.blocks : [];
        for (const bk of blocks) {
          const p = parseKey(bk);
          if (!p) continue;
          if (p.dimId !== entry.dimId) continue;
          const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
          if (b?.typeId === BEAM_ID) {
            b.setType("minecraft:air");
            enqueueAdjacentBeams(dim, p);
            enqueueAdjacentPrisms(dim, p);
          }
        }
      }
  } catch {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// LOS scanning and rebuild
// -----------------------------------------------------------------------------
function scanOutputsInDir(dim, loc, dx, dy, dz) {
  const outputs = [];
  let prismDist = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === OUTPUT_ID) {
      outputs.push(i);
      continue;
    }
    if (id === PRISM_ID) {
      prismDist = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    // Any other block (including inputs) blocks the scan.
    break;
  }
  return { outputs, prismDist };
}

function recordBeamKey(recorded, recordedSet, dimId, x, y, z) {
  const k = key(dimId, x, y, z);
  if (recordedSet.has(k)) return;
  recordedSet.add(k);
  recorded.push(k);
}

function fillBeamsToDistance(dim, loc, dx, dy, dz, dist, axis, recorded, recordedSet) {
  for (let i = 1; i < dist; i++) {
    const x = loc.x + dx * i;
    const y = loc.y + dy * i;
    const z = loc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === "minecraft:air") {
      if (placeBeamIfAir(dim, x, y, z, axis)) recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
      continue;
    }

    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) {
        recordBeamKey(recorded, recordedSet, dim.id, x, y, z);
        continue;
      }
      break;
    }

    if (id === OUTPUT_ID) continue;
    if (id === PRISM_ID) break;

    // Blocker appeared unexpectedly; stop filling.
    break;
  }
}

function rebuildInputBeams(entry) {
  const dim = getDimensionById(entry?.dimId);
  if (!dim) return;

  const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!ib || ib.typeId !== INPUT_ID) return;

  removeRecordedBeams(entry);

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  const recorded = [];
  const recordedSet = new Set();
  for (const d of dirs) {
    const res = scanOutputsInDir(dim, entry, d.dx, d.dy, d.dz);
    const maxOut = res.outputs.length > 0 ? res.outputs[res.outputs.length - 1] : 0;
    const axis = axisForDir(d.dx, d.dy, d.dz);
    if (maxOut > 0) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, maxOut, axis, recorded, recordedSet);
    }
    if (res.prismDist > 1) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, res.prismDist, axis, recorded, recordedSet);
      const prismKey = key(entry.dimId, entry.x + d.dx * res.prismDist, entry.y + d.dy * res.prismDist, entry.z + d.dz * res.prismDist);
      enqueueRelayForRescan(prismKey);
    }
  }

  entry.beams = recorded;
  delete entry.rays;
}

function rebuildRelayBeams(entry, map) {
  const dim = getDimensionById(entry?.dimId);
  if (!dim) return;

  const pb = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
  if (!pb || pb.typeId !== PRISM_ID) {
    removeRecordedBeams(entry);
    delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
    return;
  }

  if (!prismHasRelaySource(dim, entry)) {
    removeRecordedBeams(entry);
    delete map[key(entry.dimId, entry.x, entry.y, entry.z)];
    return;
  }

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  const recorded = [];
  const recordedSet = new Set();
  for (const d of dirs) {
    const res = scanOutputsInDir(dim, entry, d.dx, d.dy, d.dz);
    const maxOut = res.outputs.length > 0 ? res.outputs[res.outputs.length - 1] : 0;
    const axis = axisForDir(d.dx, d.dy, d.dz);
    if (maxOut > 0) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, maxOut, axis, recorded, recordedSet);
    }
    if (res.prismDist > 1) {
      fillBeamsToDistance(dim, entry, d.dx, d.dy, d.dz, res.prismDist, axis, recorded, recordedSet);
      const prismKey = key(entry.dimId, entry.x + d.dx * res.prismDist, entry.y + d.dy * res.prismDist, entry.z + d.dz * res.prismDist);
      enqueueRelayForRescan(prismKey);
    }
  }

  entry.beams = recorded;
  entry.kind = "prism";
  delete entry.rays;
  map[key(entry.dimId, entry.x, entry.y, entry.z)] = entry;
}

function rebuildOrRemoveAllDeterministically() {
  const map = loadBeamsMap();
  let changed = false;

  for (const inputKey of Object.keys(map)) {
    const entry = map[inputKey];
    if (!entry || typeof entry !== "object") {
      delete map[inputKey];
      changed = true;
      continue;
    }

    const dim = getDimensionById(entry.dimId);
    if (!dim) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    removeRecordedBeams(entry);

    const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
    if (!ib || ib.typeId !== INPUT_ID) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    entry.beams = [];
    entry.kind = "input";
    delete entry.rays;
    map[inputKey] = entry;
    changed = true;

    enqueueInputForRescan(inputKey);
  }

  if (changed) saveBeamsMap(map);
}

// -----------------------------------------------------------------------------
// Beam validation (local, budgeted)
// -----------------------------------------------------------------------------
function beamValidFromInput(dim, inputLoc, dx, dy, dz, beamDist) {
  let farthestOutput = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = inputLoc.x + dx * i;
    const y = inputLoc.y + dy * i;
    const z = inputLoc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === OUTPUT_ID || id === PRISM_ID) {
      farthestOutput = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }

    break;
  }
  return farthestOutput > beamDist;
}

function beamValidFromPrism(dim, prismLoc, dx, dy, dz, beamDist) {
  if (!prismHasRelaySource(dim, prismLoc)) return false;

  let farthestNode = 0;
  for (let i = 1; i <= MAX_BEAM_LEN; i++) {
    const x = prismLoc.x + dx * i;
    const y = prismLoc.y + dy * i;
    const z = prismLoc.z + dz * i;
    const b = dim.getBlock({ x, y, z });
    if (!b) break;

    const id = b.typeId;
    if (id === OUTPUT_ID || id === PRISM_ID) {
      farthestNode = i;
      break;
    }
    if (id === "minecraft:air") continue;
    if (id === BEAM_ID) {
      if (beamAxisMatchesDir(b, dx, dy, dz)) continue;
      break;
    }
    break;
  }
  return farthestNode > beamDist;
}

function isBeamStillValid(dim, loc) {
  const b = dim.getBlock(loc);
  if (!b || b.typeId !== BEAM_ID) return false;

  const axis = getBeamAxis(b);
  const dirs = beamDirsForAxis(axis);

  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const scan = dim.getBlock({ x, y, z });
      if (!scan) break;

      const id = scan.typeId;
      if (id === INPUT_ID) {
        if (beamValidFromInput(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) return true;
        break;
      }
      if (id === PRISM_ID) {
        if (beamValidFromPrism(dim, scan.location, -d.dx, -d.dy, -d.dz, i)) return true;
        break;
      }
      if (id === BEAM_ID) {
        if (beamAxisMatchesDir(scan, d.dx, d.dy, d.dz)) continue;
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
  }

  return false;
}

// -----------------------------------------------------------------------------
// Placement reliability helpers (event-seeded, bounded retries)
// -----------------------------------------------------------------------------
const pendingEmit = new Set();

function scheduleEmitAt(dim, loc, attempt) {
  try {
    if (!dim || !loc) return;

    const dimId = dim.id;
    const k = key(dimId, loc.x, loc.y, loc.z);

    if ((attempt | 0) === 0) {
      if (pendingEmit.has(k)) return;
      pendingEmit.add(k);
    }

    const placed = dim.getBlock(loc);

    if (placed && placed.typeId === INPUT_ID) {
      pendingEmit.delete(k);
      handleInputPlaced(placed);
      return;
    }

    const a = (attempt | 0) + 1;
    if (a < EMIT_RETRY_TICKS) {
      system.runTimeout(() => scheduleEmitAt(dim, loc, a), 1);
    } else {
      pendingEmit.delete(k);
    }
  } catch {
    // ignore
  }
}

const FACE_OFFSETS = {
  Up: { x: 0, y: 1, z: 0 },
  Down: { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 },
  South: { x: 0, y: 0, z: 1 },
  West: { x: -1, y: 0, z: 0 },
  East: { x: 1, y: 0, z: 0 },
};

function handleBlockChanged(dim, loc, prevId, nextId) {
  if (!dim || !loc) return;

  bumpNetworkStamp();
  enqueueAdjacentBeams(dim, loc);

  const self = dim.getBlock(loc);
  const selfId = nextId || self?.typeId;
  const beamChanged = (prevId === BEAM_ID || selfId === BEAM_ID);
  if (beamChanged) enqueueAdjacentPrisms(dim, loc);

  if (selfId === PRISM_ID || prevId === PRISM_ID) {
    enqueueRelayForRescan(key(dim.id, loc.x, loc.y, loc.z));
  }
  if (prevId === PRISM_ID) {
    const map = loadBeamsMap();
    const prismKey = key(dim.id, loc.x, loc.y, loc.z);
    const entry = map[prismKey];
    if (entry) {
      removeRecordedBeams(entry);
      delete map[prismKey];
      saveBeamsMap(map);
    }
    enqueueBeamsInLine(dim, loc);
    clearBeamsFromBreak(dim, loc);
  }

  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];

  for (const d of dirs) {
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = loc.x + d.dx * i;
      const y = loc.y + d.dy * i;
      const z = loc.z + d.dz * i;
      const b = dim.getBlock({ x, y, z });
      if (!b) break;

      const id = b.typeId;
      if (id === INPUT_ID) {
        enqueueInputForRescan(key(dim.id, x, y, z));
        break;
      }
      if (id === PRISM_ID) {
        enqueueRelayForRescan(key(dim.id, x, y, z));
        break;
      }
      if (isPassThrough(id)) continue;
      break;
    }
  }
}

function handleInputPlaced(block) {
  try {
    if (!block) return;

    const dim = block.dimension;
    const loc = block.location;
    if (!dim || !loc) return;

    const placed = dim.getBlock(loc);
    if (!placed || placed.typeId !== INPUT_ID) return;

    const dimId = placed.dimension.id;
    const { x, y, z } = placed.location;
    const inputKey = key(dimId, x, y, z);

    const map = loadBeamsMap();
    const entry = { dimId, x, y, z, beams: [], kind: "input" };
    map[inputKey] = entry;
    saveBeamsMap(map);

    enqueueInputForRescan(inputKey);
    handleBlockChanged(dim, loc);
  } catch {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// Event wiring + main tick
// -----------------------------------------------------------------------------
export function startBeamSimV0() {
  rebuildOrRemoveAllDeterministically();

  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const b = ev?.block;
      if (!b) return;
      scheduleEmitAt(b.dimension, b.location, 0);
      handleBlockChanged(b.dimension, b.location, null, b.typeId);
    } catch {
      // ignore
    }
  });

  try {
    world.afterEvents.entityPlaceBlock.subscribe((ev) => {
      try {
        const b = ev?.block;
        if (!b) return;
        scheduleEmitAt(b.dimension, b.location, 0);
        handleBlockChanged(b.dimension, b.location, null, b.typeId);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    world.afterEvents.blockPlace.subscribe((ev) => {
      try {
        const b = ev?.block;
        if (!b) return;
        scheduleEmitAt(b.dimension, b.location, 0);
        handleBlockChanged(b.dimension, b.location, null, b.typeId);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  try {
    world.afterEvents.itemUseOn.subscribe((ev) => {
      try {
        const itemId = ev?.itemStack?.typeId;
        if (itemId !== INPUT_ID) return;

        const clicked = ev?.block;
        const face = ev?.blockFace;
        if (!clicked || !face) return;

        const off = FACE_OFFSETS[face];
        if (!off) return;

        const loc = clicked.location;
        const target = { x: loc.x + off.x, y: loc.y + off.y, z: loc.z + off.z };
        scheduleEmitAt(clicked.dimension, target, 0);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }

  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev.brokenBlockPermutation?.type?.id;
      const dim = ev.block?.dimension;
      const loc = ev.block?.location;
      if (!dim || !loc) return;

      if (brokenId === INPUT_ID) {
        const inputKey = key(dim.id, loc.x, loc.y, loc.z);
        const map = loadBeamsMap();
        if (map[inputKey]) {
          delete map[inputKey];
          saveBeamsMap(map);
        }
      }

      handleBlockChanged(dim, loc, brokenId, "minecraft:air");
    } catch {
      // ignore
    }
  });

  system.runInterval(() => {
    const map = loadBeamsMap();
    let changed = false;

    let validationBudget = VALIDATIONS_PER_TICK;
    while (validationBudget-- > 0 && pendingValidations.length > 0) {
      const beamKey = pendingValidations.shift();
      pendingValidationsSet.delete(beamKey);

      const p = parseKey(beamKey);
      if (!p) continue;
      const dim = getDimensionById(p.dimId);
      if (!dim) continue;

      const loc = { x: p.x, y: p.y, z: p.z };
      if (isBeamStillValid(dim, loc)) continue;

      const b = dim.getBlock(loc);
      if (b?.typeId === BEAM_ID) {
        b.setType("minecraft:air");
        enqueueAdjacentBeams(dim, loc);
        enqueueAdjacentPrisms(dim, loc);
      }
    }

    let inputBudget = INPUTS_PER_TICK;
    while (inputBudget-- > 0 && pendingInputs.length > 0) {
      const inputKey = pendingInputs.shift();
      pendingInputsSet.delete(inputKey);

      const entry = map[inputKey];
      if (!entry) continue;

      const dim = getDimensionById(entry.dimId);
      if (!dim) continue;

      const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
      if (!ib || ib.typeId !== INPUT_ID) {
        delete map[inputKey];
        changed = true;
        continue;
      }

      rebuildInputBeams(entry);
      map[inputKey] = entry;
      changed = true;
    }

    let relayBudget = RELAYS_PER_TICK;
    while (relayBudget-- > 0 && pendingRelays.length > 0) {
      const prismKey = pendingRelays.shift();
      pendingRelaysSet.delete(prismKey);

      const entry = map[prismKey] || (() => {
        const p = parseKey(prismKey);
        if (!p) return null;
        return { dimId: p.dimId, x: p.x, y: p.y, z: p.z, beams: [], kind: "prism" };
      })();
      if (!entry) continue;

      rebuildRelayBeams(entry, map);
      changed = true;
    }

    if (changed) saveBeamsMap(map);
  }, TICK_INTERVAL);
}
