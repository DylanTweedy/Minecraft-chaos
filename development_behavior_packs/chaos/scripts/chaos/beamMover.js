// scripts/chaos/beamMover.js
import { system, world } from "@minecraft/server";

const BEAM_ID = "chaos:beam";

// Dynamic property keys (server-only)
const DP = {
  sx: "chaos:sx",
  sy: "chaos:sy",
  sz: "chaos:sz",
  dx: "chaos:dx",
  dy: "chaos:dy",
  dz: "chaos:dz",
  max: "chaos:maxLen",
  speed: "chaos:speed",
  acc: "chaos:acc",         // fractional accumulator for float speeds
  collide: "chaos:collide", // 1/0
};

// Synced entity property IDs (BP properties w/ client_sync: true)
const PROP = {
  len: "chaos:beam_len",
  alpha: "chaos:beam_alpha", // optional; safe-set only
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function mul(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }

function isNum(n) { return typeof n === "number" && isFinite(n); }

function safeSetProperty(entity, id, value) {
  try {
    if (typeof entity.setProperty === "function") entity.setProperty(id, value);
  } catch {
    // ignore missing property
  }
}

function safeGetProperty(entity, id, fallback) {
  try {
    if (typeof entity.getProperty === "function") {
      const v = entity.getProperty(id);
      return isNum(v) ? v : fallback;
    }
  } catch {}
  return fallback;
}

function setDP(entity, key, value) {
  try { entity.setDynamicProperty(key, value); } catch {}
}

function getDP(entity, key, fallback = undefined) {
  try {
    const v = entity.getDynamicProperty(key);
    return (v === undefined || v === null) ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Quantize any direction-ish vector to a single axis unit vector.
 * This ensures consistent rotation + block stepping.
 */
function quantizeToAxis(dir) {
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  if (ay >= ax && ay >= az) return { x: 0, y: dir.y >= 0 ? 1 : -1, z: 0 };
  if (ax >= ay && ax >= az) return { x: dir.x >= 0 ? 1 : -1, y: 0, z: 0 };
  return { x: 0, y: 0, z: dir.z >= 0 ? 1 : -1 };
}

/**
 * Convert axis dir to rotation (degrees) assuming geometry faces +Z.
 */
function axisToRotation(axis) {
  if (axis.x === 1)  return { x: 0,  y: -90 };
  if (axis.x === -1) return { x: 0,  y: 90 };
  if (axis.z === 1)  return { x: 0,  y: 0 };
  if (axis.z === -1) return { x: 0,  y: 180 };
  if (axis.y === 1)  return { x: -90, y: 0 };
  return               { x: 90,  y: 0 }; // axis.y === -1
}

function shouldCollide(block) {
  if (!block) return false;
  if (block.typeId === "minecraft:air") return false;
  // optional: let beams pass through liquids
  if (block.typeId === "minecraft:water" || block.typeId === "minecraft:lava") return false;
  return true;
}

/**
 * Collision check at the next segment tip.
 * Strategy A pivot means base is fixed; tip is at base + dir*(len - eps)
 * For block stepping we check the block at base + dir*(len - 0.5)
 */
function collisionAtNext(dim, base, dir, nextLen) {
  const tipCenter = add(base, mul(dir, nextLen - 0.5));
  const bp = { x: Math.floor(tipCenter.x), y: Math.floor(tipCenter.y), z: Math.floor(tipCenter.z) };
  const block = dim.getBlock(bp);
  return shouldCollide(block);
}

function readParams(beam) {
  const sx = getDP(beam, DP.sx);
  const sy = getDP(beam, DP.sy);
  const sz = getDP(beam, DP.sz);

  const dx = getDP(beam, DP.dx);
  const dy = getDP(beam, DP.dy);
  const dz = getDP(beam, DP.dz);

  if (![sx, sy, sz, dx, dy, dz].every(isNum)) return null;

  const maxLen = getDP(beam, DP.max, 16);
  const speed = getDP(beam, DP.speed, 1);
  const acc = getDP(beam, DP.acc, 0);
  const collide = getDP(beam, DP.collide, 0);

  return {
    base: { x: sx, y: sy, z: sz },
    dir: { x: dx, y: dy, z: dz },
    maxLen: isNum(maxLen) ? maxLen : 16,
    speed: isNum(speed) ? speed : 1,
    acc: isNum(acc) ? acc : 0,
    collide: (collide | 0) !== 0,
  };
}

/**
 * Public entry point: spawn a beam that grows from base along dir.
 *
 * cfg.start must already be the correct face emission point (face center + eps).
 * dir can be any vector; it will be quantized to an axis.
 */
export function startBeamGrow(dim, cfg) {
  const start = cfg.start;
  const rawDir = cfg.dir;

  if (!start || !rawDir) return null;

  const dir = quantizeToAxis(rawDir);

  const maxBlocks = clamp(cfg.maxBlocks ?? 16, 1, 128);
  const speed = clamp(cfg.speedBlocksPerTick ?? 1, 0.05, 64);

  const beam = dim.spawnEntity(BEAM_ID, start);

  // Orient along axis (geometry assumes +Z forward)
  beam.setRotation(axisToRotation(dir));

  // Initialize synced visuals
  safeSetProperty(beam, PROP.len, 1.0);
  safeSetProperty(beam, PROP.alpha, 1.0); // optional

  // Store base + direction
  setDP(beam, DP.sx, start.x);
  setDP(beam, DP.sy, start.y);
  setDP(beam, DP.sz, start.z);

  setDP(beam, DP.dx, dir.x);
  setDP(beam, DP.dy, dir.y);
  setDP(beam, DP.dz, dir.z);

  // Config
  setDP(beam, DP.max, maxBlocks);
  setDP(beam, DP.speed, speed);
  setDP(beam, DP.acc, 0);

  // Optional per-beam collision
  setDP(beam, DP.collide, cfg.collide === true ? 1 : 0);

  return beam;
}

/**
 * Tick loop: grows beams by updating chaos:beam_len.
 * Strategy A: beam base stays fixed; scale extends forward along local +Z.
 */
system.runInterval(() => {
  const dim = world.getDimension("overworld");
  const beams = dim.getEntities({ type: BEAM_ID });

  for (const beam of beams) {
    try {
      const params = readParams(beam);
      if (!params) continue;

      // Keep base anchored (prevents drift)
      beam.teleport(params.base, { checkForBlocks: false });

      // Current length (synced property used by client animation)
      let len = safeGetProperty(beam, PROP.len, 1.0);
      if (!isNum(len) || len < 1) len = 1.0;

      // Accumulate growth for float speeds
      let acc = params.acc + params.speed;
      let steps = Math.floor(acc);
      acc -= steps;

      if (steps <= 0) {
        setDP(beam, DP.acc, acc);
        continue;
      }

      while (steps-- > 0) {
        const nextLen = len + 1;

        // Finished
        if (nextLen > params.maxLen) {
          beam.triggerEvent("chaos:despawn");
          break;
        }

        // Optional collision stop
        if (params.collide && collisionAtNext(dim, params.base, params.dir, nextLen)) {
          // Keep current len, then despawn
          safeSetProperty(beam, PROP.len, len);
          beam.triggerEvent("chaos:despawn");
          steps = 0;
          break;
        }

        len = nextLen;
        safeSetProperty(beam, PROP.len, len);
      }

      setDP(beam, DP.acc, acc);
    } catch {
      // ignore per-beam errors
    }
  }
}, 1);
