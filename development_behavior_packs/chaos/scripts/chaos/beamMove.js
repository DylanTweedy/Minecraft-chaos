// scripts/chaos/beamMove.js
import { system, world } from "@minecraft/server";

const PROP = {
  len: "chaos:beam_len",
  alpha: "chaos:beam_alpha",
  pitch: "chaos:pitch",
  yaw: "chaos:yaw",
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
  pitch: "chaos:beam_pitch_dp",
  yaw: "chaos:beam_yaw_dp",
  life: "chaos:beam_life",
  propsOk: "chaos:beam_props_ok",
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isNum(n) { return typeof n === "number" && isFinite(n); }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function len(v) { return Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z); }
function norm(v) {
  const l = len(v);
  if (l <= 1e-6) return { x: 0, y: 0, z: 1 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function center(b) { return { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 }; }

// Model forward is +Z
function dirToPitchYaw(d) {
  const yaw = Math.atan2(-d.x, d.z) * 180 / Math.PI;
  const pitch = Math.atan2(-d.y, Math.sqrt(d.x*d.x + d.z*d.z)) * 180 / Math.PI;
  return { pitch, yaw };
}

function dpSet(e, k, v) { try { e.setDynamicProperty(k, v); } catch {} }
function dpGet(e, k, fb) {
  try {
    const v = e.getDynamicProperty(k);
    return isNum(v) ? v : fb;
  } catch { return fb; }
}

function trySet(e, key, value, player) {
  try {
    e.setProperty(key, value);
    return true;
  } catch (err) {
    player?.sendMessage?.(`[Chaos] setProperty FAIL ${key}: ${String(err)}`);
    return false;
  }
}

function tryGet(e, key, player) {
  try {
    return e.getProperty(key);
  } catch (err) {
    player?.sendMessage?.(`[Chaos] getProperty FAIL ${key}: ${String(err)}`);
    return undefined;
  }
}

function safeRemove(e) { try { e.remove(); } catch {} }

export function spawnTestBeam(player, cfg) {
  const dim = player.dimension;
  const start = center(cfg.startBlock);
  const end = center(cfg.endBlock);

  const d = sub(end, start);
  const dist = len(d);
  if (dist < 0.01) return null;

  const dir = norm(d);
  const { pitch, yaw } = dirToPitchYaw(dir);

  const beam = dim.spawnEntity(cfg.beamId, start);
  if (!beam) {
    player.sendMessage("[Chaos] spawnEntity FAILED");
    return null;
  }
  
  player.sendMessage(`[Chaos] Spawned ${beam.typeId}`);

  // ✅ BP sanity check (type family we added)
  try {
    const fam = beam.getComponent("minecraft:type_family");
    const families = fam?.families ?? [];
    const ok = families.includes("chaos_beam_entity_bp_ok");
    player.sendMessage(`[Chaos] BP family check: ${ok ? "OK" : "MISSING"} (${families.join(",")})`);
  } catch (e) {
    player.sendMessage(`[Chaos] BP family check: ERROR ${String(e)}`);
  }

  // Server params
  dpSet(beam, DP.sx, start.x);
  dpSet(beam, DP.sy, start.y);
  dpSet(beam, DP.sz, start.z);
  dpSet(beam, DP.max, clamp(Math.floor(dist), 1, 64));
  dpSet(beam, DP.speed, clamp(cfg.speedBlocksPerTick ?? 2, 0.1, 64));
  dpSet(beam, DP.acc, 0);
  dpSet(beam, DP.spinTick, clamp(cfg.spinDegPerTick ?? 0, 0, 2000));
  dpSet(beam, DP.alpha, clamp(cfg.alpha ?? 1, 0, 1));
  dpSet(beam, DP.pitch, clamp(pitch, -90, 90));
  dpSet(beam, DP.yaw, clamp(yaw, -180, 180));
  dpSet(beam, DP.life, 120); // 6s script life while debugging

  const applyProps = (tag) => {
    const okLen = trySet(beam, PROP.len, 1, player);
    const okA   = trySet(beam, PROP.alpha, dpGet(beam, DP.alpha, 1), player);
    const okP   = trySet(beam, PROP.pitch, dpGet(beam, DP.pitch, 0), player);
    const okY   = trySet(beam, PROP.yaw, dpGet(beam, DP.yaw, 0), player);
    const okS   = trySet(beam, PROP.spin, 0, player);

    player.sendMessage(`[Chaos] ${tag} set ok: len=${okLen} a=${okA} p=${okP} y=${okY} s=${okS}`);
    
    const gl = tryGet(beam, PROP.len, player);
    const ga = tryGet(beam, PROP.alpha, player);
    const gp = tryGet(beam, PROP.pitch, player);
    const gy = tryGet(beam, PROP.yaw, player);
    const gs = tryGet(beam, PROP.spin, player);

    player.sendMessage(`[Chaos] ${tag} get: len=${gl} a=${ga} p=${gp} y=${gy} s=${gs}`);
    
system.runTimeout(() => {
  try {
    player.sendMessage("canary=" + beam.getProperty("chaos:canary"));
  } catch (e) {
    player.sendMessage("canary get err=" + e);
  }
}, 2);
    dpSet(beam, DP.propsOk, (okLen && okA && okP && okY && okS) ? 1 : 0);
  };

  // Apply twice (spawn tick + next tick)
  applyProps("T0");
  system.runTimeout(() => applyProps("T+1"), 1);

  return beam;
}

// Tick: anchor + grow + spin (only when propsOk=1)
system.runInterval(() => {
  const dim = world.getDimension("overworld");
  for (const beam of dim.getEntities()) {
    try {
      // only process our beam type (avoid touching mobs)
      if (beam.typeId !== "chaos:beam_entity") continue;

      let life = dpGet(beam, DP.life, 0);
      if (life > 0) {
        life--;
        dpSet(beam, DP.life, life);
        if (life <= 0) { safeRemove(beam); continue; }
      }

      const sx = dpGet(beam, DP.sx, NaN);
      const sy = dpGet(beam, DP.sy, NaN);
      const sz = dpGet(beam, DP.sz, NaN);
      if (![sx, sy, sz].every(isNum)) continue;

      beam.teleport({ x: sx, y: sy, z: sz }, { checkForBlocks: false });

      const propsOk = dpGet(beam, DP.propsOk, 0) === 1;
      if (!propsOk) continue;

      // Grow
      const maxLen = dpGet(beam, DP.max, 1);
      const speed = dpGet(beam, DP.speed, 1);
      let acc = dpGet(beam, DP.acc, 0);

      let curLen = beam.getProperty(PROP.len);
      if (!isNum(curLen) || curLen < 1) curLen = 1;

      acc += speed;
      const steps = Math.floor(acc);
      acc -= steps;

      if (steps > 0) {
        curLen = clamp(curLen + steps, 1, maxLen);
        try { beam.setProperty(PROP.len, curLen); } catch {}
      }
      dpSet(beam, DP.acc, acc);

      // Spin
      let spin = beam.getProperty(PROP.spin);
      if (!isNum(spin)) spin = 0;
      spin = (spin + dpGet(beam, DP.spinTick, 0)) % 360;
      try { beam.setProperty(PROP.spin, spin); } catch {}

    } catch {
      // ignore
    }
  }
}, 1);
