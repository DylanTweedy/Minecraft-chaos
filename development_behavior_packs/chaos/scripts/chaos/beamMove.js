// scripts/chaos/beamMove.js
import { system, world } from "@minecraft/server";

// These are still actor properties (len/alpha/spin).
// If you later decide to remove ALL actor properties, we can switch growth to
// "replace entity with longer variant" style instead.
const PROP = {
  len: "chaos:beam_len",
  alpha: "chaos:beam_alpha",
  spin: "chaos:beam_spin",
};

const DP = {
  sx: "chaos:beam_sx",
  sy: "chaos:beam_sy",
  sz: "chaos:beam_sz",
  max: "chaos:beam_max",
  speed: "chaos:beam_speed",
  acc: "chaos:beam_acc",
  spinTick: "chaos:beam_spinTick",
  alpha: "chaos:beam_alpha_dp",
  life: "chaos:beam_life",
  propsOk: "chaos:beam_props_ok",
};

const BEAM_TYPES = new Set(["chaos:beam_h", "chaos:beam_v"]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isNum(n) { return typeof n === "number" && isFinite(n); }
function center(b) { return { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 }; }

function dpSet(e, k, v) { try { e.setDynamicProperty(k, v); } catch {} }
function dpGet(e, k, fb) {
  try {
    const v = e.getDynamicProperty(k);
    return isNum(v) ? v : fb;
  } catch { return fb; }
}

function trySet(e, key, value) {
  try { e.setProperty(key, value); return true; }
  catch { return false; }
}

function tryGet(e, key) {
  try { return e.getProperty(key); }
  catch { return undefined; }
}

function safeRemove(e) { try { e.remove(); } catch {} }

/**
 * Spawns a beam at startBlock and grows it toward endBlock by increasing chaos:beam_len.
 * beamId should be "chaos:beam_h" or "chaos:beam_v".
 */
export function spawnTestBeam(player, cfg) {
  const dim = player.dimension;
  const start = center(cfg.startBlock);
  const end = center(cfg.endBlock);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

  if (dist < 0.01) return null;

  const beam = dim.spawnEntity(cfg.beamId, start);
  if (!beam) {
    player?.sendMessage?.("[Chaos] spawnEntity FAILED");
    return null;
  }

  // Anchor params
  dpSet(beam, DP.sx, start.x);
  dpSet(beam, DP.sy, start.y);
  dpSet(beam, DP.sz, start.z);

  dpSet(beam, DP.max, clamp(Math.floor(dist), 1, 64));
  dpSet(beam, DP.speed, clamp(cfg.speedBlocksPerTick ?? 2, 0.1, 64));
  dpSet(beam, DP.acc, 0);

  dpSet(beam, DP.spinTick, clamp(cfg.spinDegPerTick ?? 0, 0, 2000));
  dpSet(beam, DP.alpha, clamp(cfg.alpha ?? 1, 0, 1));

  dpSet(beam, DP.life, cfg.lifeTicks ?? 120); // default 6s while testing

  // Attempt to apply props once. If this fails, growth/spin won't happen.
  const okLen = trySet(beam, PROP.len, 1);
  const okA   = trySet(beam, PROP.alpha, dpGet(beam, DP.alpha, 1));
  const okS   = trySet(beam, PROP.spin, 0);

  dpSet(beam, DP.propsOk, (okLen && okA && okS) ? 1 : 0);

  // Optional debug
  player?.sendMessage?.(
    `[Chaos] Spawned ${beam.typeId} dist=${Math.floor(dist)} propsOk=${(okLen && okA && okS) ? "1" : "0"}`
  );

  // Optional: readback
  const gl = tryGet(beam, PROP.len);
  const ga = tryGet(beam, PROP.alpha);
  const gs = tryGet(beam, PROP.spin);
  player?.sendMessage?.(`[Chaos] get: len=${gl} a=${ga} s=${gs}`);

  return beam;
}

// Tick: anchor + grow + spin
system.runInterval(() => {
  const dim = world.getDimension("overworld");

  for (const beam of dim.getEntities()) {
    try {
      if (!BEAM_TYPES.has(beam.typeId)) continue;

      // lifetime
      let life = dpGet(beam, DP.life, 0);
      if (life > 0) {
        life--;
        dpSet(beam, DP.life, life);
        if (life <= 0) { safeRemove(beam); continue; }
      }

      // anchor
      const sx = dpGet(beam, DP.sx, NaN);
      const sy = dpGet(beam, DP.sy, NaN);
      const sz = dpGet(beam, DP.sz, NaN);
      if (![sx, sy, sz].every(isNum)) continue;

      beam.teleport({ x: sx, y: sy, z: sz }, { checkForBlocks: false });

      const propsOk = dpGet(beam, DP.propsOk, 0) === 1;
      if (!propsOk) continue;

      // grow
      const maxLen = dpGet(beam, DP.max, 1);
      const speed = dpGet(beam, DP.speed, 1);
      let acc = dpGet(beam, DP.acc, 0);

      let curLen = tryGet(beam, PROP.len);
      if (!isNum(curLen) || curLen < 1) curLen = 1;

      acc += speed;
      const steps = Math.floor(acc);
      acc -= steps;

      if (steps > 0) {
        curLen = clamp(curLen + steps, 1, maxLen);
        trySet(beam, PROP.len, curLen);
      }
      dpSet(beam, DP.acc, acc);

      // spin (optional)
      let spin = tryGet(beam, PROP.spin);
      if (!isNum(spin)) spin = 0;
      spin = (spin + dpGet(beam, DP.spinTick, 0)) % 360;
      trySet(beam, PROP.spin, spin);

    } catch {
      // ignore per-entity errors
    }
  }
}, 1);
