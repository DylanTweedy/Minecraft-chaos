// scripts/chaos/beamMover.js
import { system, world } from "@minecraft/server";

const BEAM_ID = "chaos:beam";

// Server-only dynamic properties
const DP = {
  sx: "chaos:sx",
  sy: "chaos:sy",
  sz: "chaos:sz",
  max: "chaos:maxLen",
  speed: "chaos:speed",
  acc: "chaos:acc",
};

// Synced entity properties (must exist in BP with client_sync: true)
const PROP = {
  len: "chaos:beam_len",
  pitch: "chaos:beam_pitch",
  yaw: "chaos:beam_yaw",
};

function isNum(n) { return typeof n === "number" && isFinite(n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

function blockCenter(b) {
  return { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 };
}

function length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v) {
  const l = length(v);
  if (l <= 0.000001) return { x: 0, y: 0, z: 1 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Convert direction vector to pitch/yaw for Bedrock animations.
 * Assumes model forward is +Z.
 */
function dirToPitchYaw(d) {
  // yaw: rotate around Y to aim X/Z
  const yaw = Math.atan2(-d.x, d.z) * 180 / Math.PI;
  // pitch: rotate around X to aim up/down
  const pitch = Math.atan2(-d.y, Math.sqrt(d.x * d.x + d.z * d.z)) * 180 / Math.PI;
  return { pitch, yaw };
}

function setDP(e, k, v) { try { e.setDynamicProperty(k, v); } catch {} }
function getDP(e, k, fallback) {
  try {
    const v = e.getDynamicProperty(k);
    return isNum(v) ? v : fallback;
  } catch { return fallback; }
}

function safeSetProp(e, k, v) {
  try { e.setProperty(k, v); return true; } catch { return false; }
}

function safeGetProp(e, k, fallback) {
  try {
    const v = e.getProperty(k);
    return isNum(v) ? v : fallback;
  } catch { return fallback; }
}

/**
 * Grow a beam between two BLOCK positions, at speed blocks per tick.
 * Rotation + scale are driven by synced properties used in RP animation.
 */
export function startBeamBetween(dim, cfg) {
  const startBlock = cfg.startBlock;
  const endBlock = cfg.endBlock;
  if (!startBlock || !endBlock) return null;

  const start = blockCenter(startBlock);
  const end = blockCenter(endBlock);

  const delta = sub(end, start);
  const dist = length(delta);
  if (dist < 0.01) return null;

  const dir = normalize(delta);
  const { pitch, yaw } = dirToPitchYaw(dir);

  // We want "block steps" of growth; dist is in blocks already.
  const maxLen = clamp(Math.floor(dist), 1, 64);
  const speed = clamp(cfg.speedBlocksPerTick ?? 1, 0.1, 64);

  const beam = dim.spawnEntity(BEAM_ID, start);
  if (!beam) return null;

  // Set client-driven visuals immediately.
  // If these property IDs don't exist / aren't client_sync, animation will read 0 -> invisible.
  safeSetProp(beam, PROP.pitch, pitch);
  safeSetProp(beam, PROP.yaw, yaw);

  // IMPORTANT: never allow 0 length or beam can vanish depending on animation
  safeSetProp(beam, PROP.len, 1);

  // Store server growth params
  setDP(beam, DP.sx, start.x);
  setDP(beam, DP.sy, start.y);
  setDP(beam, DP.sz, start.z);
  setDP(beam, DP.max, maxLen);
  setDP(beam, DP.speed, speed);
  setDP(beam, DP.acc, 0);

  return beam;
}

// Tick: anchor position only, update beam_len only
system.runInterval(() => {
  const dim = world.getDimension("overworld");
  const beams = dim.getEntities({ type: BEAM_ID });

  for (const beam of beams) {
    try {
      const sx = getDP(beam, DP.sx, NaN);
      const sy = getDP(beam, DP.sy, NaN);
      const sz = getDP(beam, DP.sz, NaN);
      if (![sx, sy, sz].every(isNum)) continue;

      // Keep the entity anchored (no rotation here)
      beam.teleport({ x: sx, y: sy, z: sz }, { checkForBlocks: false });

      const maxLen = getDP(beam, DP.max, 1);
      const speed = getDP(beam, DP.speed, 1);
      let acc = getDP(beam, DP.acc, 0);

      let len = safeGetProp(beam, PROP.len, 1);
      if (!isNum(len) || len < 1) len = 1;

      acc += speed;
      let steps = Math.floor(acc);
      acc -= steps;

      while (steps-- > 0) {
        const next = len + 1;
        if (next > maxLen) {
          beam.triggerEvent("chaos:despawn"); // your BP event
          break;
        }
        len = next;
        safeSetProp(beam, PROP.len, len);
      }

      setDP(beam, DP.acc, acc);
    } catch {
      // ignore per-beam errors
    }
  }
}, 1);
