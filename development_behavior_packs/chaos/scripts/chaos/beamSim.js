// scripts/chaos/beamSim.js
import { world, system, BlockPermutation } from "@minecraft/server";

const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const BEAM_ID = "chaos:beam";

// v0 rules
const MAX_LEN = 16;          // maximum beam length (blocks)
const STEPS_PER_TICK = 1;    // 1 block per tick, but we do ONE RAY at a time (no random interleave)
const TICK_INTERVAL = 1;

// Beam block supports axis states (now x/y/z)
const AXIS_X = "x";
const AXIS_Y = "y";
const AXIS_Z = "z";

// Persistent storage (best-effort; no DynamicPropertiesDefinition)
const DP_BEAMS = "chaos:beams_v0_json";

// Placement settle window (bounded, event-seeded; NOT polling/scanning)
const EMIT_RETRY_TICKS = 4;

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

// -----------------------------------------------------------------------------
// Sequential growth scheduler (ONE RAY at a time)
// -----------------------------------------------------------------------------

// Active ray being grown step-by-step
let active = null; // { inputKey, dimId, rayIndex, dx,dy,dz, axis, nextX,nextY,nextZ, remaining }

// Inputs waiting their turn (FIFO)
const pendingInputs = []; // [inputKey, ...]
const pendingSet = new Set(); // quick dedupe

function enqueueInputForGrowth(inputKey) {
  if (!inputKey) return;
  if (active && active.inputKey === inputKey) return;
  if (pendingSet.has(inputKey)) return;
  pendingSet.add(inputKey);
  pendingInputs.push(inputKey);
}

function startNextRayForInput(inputKey, entry) {
  // entry.rays exists; find first ray that is not complete yet (blocks length < MAX_LEN) or simply by index order.
  // We track "nextRay" in memory only (not persisted). If absent, start at 0.
  if (entry.__nextRayIndex == null || !Number.isFinite(entry.__nextRayIndex)) entry.__nextRayIndex = 0;

  while (entry.__nextRayIndex < entry.rays.length) {
    const idx = entry.__nextRayIndex;
    entry.__nextRayIndex++;

    const r = entry.rays[idx];
    if (!r) continue;

    // If the ray already has blocks (e.g., rebuild state), we still treat it as complete and skip.
    // Rebuild path clears beams first, so blocks should be empty on rebuild.
    // This guard keeps us safe if anything weird was persisted.
    const blocks = Array.isArray(r.blocks) ? r.blocks : [];
    if (blocks.length > 0) continue;

    active = {
      inputKey,
      dimId: entry.dimId,
      rayIndex: idx,
      dx: r.dx,
      dy: r.dy,
      dz: r.dz,
      axis: r.axis,
      nextX: entry.x + r.dx,
      nextY: entry.y + r.dy,
      nextZ: entry.z + r.dz,
      remaining: MAX_LEN,
    };
    return true;
  }

  // No more rays for this input
  return false;
}

function pickNextActive(map) {
  if (active) return;

  while (pendingInputs.length > 0) {
    const inputKey = pendingInputs.shift();
    pendingSet.delete(inputKey);

    const entry = map[inputKey];
    if (!entry) continue;

    const dim = getDimensionById(entry.dimId);
    if (!dim) continue;

    const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
    if (!ib || ib.typeId !== INPUT_ID) continue;

    // Start the first ray for this input
    if (startNextRayForInput(inputKey, entry)) return;

    // If none started, try next input
  }
}

// -----------------------------------------------------------------------------
// Beam placement helpers
// -----------------------------------------------------------------------------
function tryPlaceBeam(dim, x, y, z, axis) {
  try {
    const b = dim.getBlock({ x, y, z });
    if (!b) return { ok: false, passthroughOutput: false };

    const id = b.typeId;

    // Output nodes are taps (do not replace, but beam continues through)
    if (id === OUTPUT_ID) return { ok: true, passthroughOutput: true };

    // Stop if we hit an input node (avoid beam interfering with other emitters)
    if (id === INPUT_ID) return { ok: false, passthroughOutput: false };

    // Only place into air or replace existing beam
    if (id !== "minecraft:air" && id !== BEAM_ID) return { ok: false, passthroughOutput: false };

    // axis must be one of x/y/z (we keep x/z swapped upstream to match geometry)
    const safeAxis = (axis === AXIS_Y ? AXIS_Y : (axis === AXIS_Z ? AXIS_Z : AXIS_X));

    // Reliable custom permutation placement
    const perm = BlockPermutation.resolve(BEAM_ID, { "chaos:axis": safeAxis });
    b.setPermutation(perm);

    return { ok: true, passthroughOutput: false };
  } catch {
    return { ok: false, passthroughOutput: false };
  }
}

function removeRecordedBeams(entry) {
  try {
    const dim = getDimensionById(entry?.dimId);
    if (!dim) return;

    const rays = Array.isArray(entry?.rays) ? entry.rays : [];
    for (const r of rays) {
      const blocks = Array.isArray(r?.blocks) ? r.blocks : [];
      for (const bk of blocks) {
        const p = parseKey(bk);
        if (!p) continue;
        if (p.dimId !== entry.dimId) continue;

        const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
        if (!b) continue;

        if (b.typeId === BEAM_ID) {
          b.setType("minecraft:air");
        }
      }
    }
  } catch {
    // ignore
  }
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

    // Deterministic cleanup
    removeRecordedBeams(entry);

    // Verify input still exists
    const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
    if (!ib || ib.typeId !== INPUT_ID) {
      delete map[inputKey];
      changed = true;
      continue;
    }

    // Rebuild: normalize rays (empty blocks) and schedule for sequential growth
    entry.rays = makeAllRays();

    // Memory-only cursor (not persisted, safe)
    entry.__nextRayIndex = 0;

    map[inputKey] = entry;
    changed = true;

    enqueueInputForGrowth(inputKey);
  }

  if (changed) saveBeamsMap(map);
}

// 6-direction rays
function makeAllRays() {
  const dirs = [
    { dx: 1, dy: 0, dz: 0 },
    { dx: -1, dy: 0, dz: 0 },
    { dx: 0, dy: 0, dz: 1 },
    { dx: 0, dy: 0, dz: -1 },
    { dx: 0, dy: 1, dz: 0 },
    { dx: 0, dy: -1, dz: 0 },
  ];
  return dirs.map((d) => ({
    dx: d.dx,
    dy: d.dy,
    dz: d.dz,
    axis: axisForDir(d.dx, d.dy, d.dz),
    blocks: [],
  }));
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

    if (map[inputKey]) {
      removeRecordedBeams(map[inputKey]);
    }

    const entry = {
      dimId,
      x,
      y,
      z,
      rays: makeAllRays(),
      __nextRayIndex: 0, // memory-only cursor for sequential growth
    };

    map[inputKey] = entry;
    saveBeamsMap(map);

    // Sequential growth: do NOT enqueue all rays; enqueue this input for processing.
    enqueueInputForGrowth(inputKey);
  } catch {
    // ignore
  }
}

export function startBeamSimV0() {
  // Reload safety
  rebuildOrRemoveAllDeterministically();

  // Place = emit
  world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
      const b = ev?.block;
      if (!b) return;
      scheduleEmitAt(b.dimension, b.location, 0);
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

  // Break = collapse
  world.afterEvents.playerBreakBlock.subscribe((ev) => {
    try {
      const brokenId = ev.brokenBlockPermutation?.type?.id;
      if (brokenId !== INPUT_ID) return;

      const dimId = ev.block?.dimension?.id;
      const loc = ev.block?.location;
      if (!dimId || !loc) return;

      const inputKey = key(dimId, loc.x, loc.y, loc.z);

      const map = loadBeamsMap();
      const entry = map[inputKey];
      if (!entry) return;

      removeRecordedBeams(entry);

      delete map[inputKey];
      saveBeamsMap(map);

      // If currently active, cancel it
      if (active && active.inputKey === inputKey) active = null;

      // Remove from pending queue
      if (pendingSet.has(inputKey)) {
        pendingSet.delete(inputKey);
        for (let i = pendingInputs.length - 1; i >= 0; i--) {
          if (pendingInputs[i] === inputKey) pendingInputs.splice(i, 1);
        }
      }

      pendingEmit.delete(inputKey);
    } catch {
      // ignore
    }
  });

  // Growth tick (sequential ray growth)
  system.runInterval(() => {
    let budget = STEPS_PER_TICK;
    if (budget <= 0) return;

    const map = loadBeamsMap();

    // If no active ray, pick the next input and start its next ray
    pickNextActive(map);
    if (!active) return;

    // Process one step (budget is 1, but keep loop structure safe)
    while (budget-- > 0 && active) {
      const entry = map[active.inputKey];
      if (!entry) {
        active = null;
        break;
      }

      const dim = getDimensionById(active.dimId);
      if (!dim) {
        active = null;
        break;
      }

      // If input vanished, collapse and drop entry
      const ib = dim.getBlock({ x: entry.x, y: entry.y, z: entry.z });
      if (!ib || ib.typeId !== INPUT_ID) {
        removeRecordedBeams(entry);
        delete map[active.inputKey];
        saveBeamsMap(map);
        active = null;
        break;
      }

      const res = tryPlaceBeam(dim, active.nextX, active.nextY, active.nextZ, active.axis);
      if (!res.ok) {
        // Ray blocked -> finish this ray and start next ray for same input (next tick)
        active = null;
        // Ensure entry has cursor; then enqueue input back if it has more rays
        if (entry.__nextRayIndex == null || !Number.isFinite(entry.__nextRayIndex)) entry.__nextRayIndex = 0;
        enqueueInputForGrowth(key(entry.dimId, entry.x, entry.y, entry.z));
        break;
      }

      // Record only actual beam placements (outputs are pass-through)
      if (!res.passthroughOutput) {
        const ray = entry.rays?.[active.rayIndex];
        if (ray) {
          if (!Array.isArray(ray.blocks)) ray.blocks = [];
          ray.blocks.push(key(active.dimId, active.nextX, active.nextY, active.nextZ));
        }
      }

      // Advance step
      active.remaining = (active.remaining | 0) - 1;

      if (active.remaining > 0) {
        active.nextX += active.dx;
        active.nextY += active.dy;
        active.nextZ += active.dz;
      } else {
        // Ray complete -> clear active and enqueue this input to continue with next ray
        active = null;
        enqueueInputForGrowth(key(entry.dimId, entry.x, entry.y, entry.z));
      }

      // Persist any changes (blocks list updates)
      saveBeamsMap(map);
    }
  }, TICK_INTERVAL);
}
