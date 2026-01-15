// scripts/chaos/core/insight/perf.js

const _stats = new Map(); // group -> Map(name -> stat)

function getStat(group, name) {
  let g = _stats.get(group);
  if (!g) {
    g = new Map();
    _stats.set(group, g);
  }
  let s = g.get(name);
  if (!s) {
    s = { last: 0, avg: 0, count: 0 };
    g.set(name, s);
  }
  return s;
}

export function noteDuration(group, name, ms) {
  if (!group || !name) return;
  const v = Math.max(0, Number(ms) || 0);
  const s = getStat(group, name);
  s.last = v;
  s.count++;
  s.avg = s.avg === 0 ? v : (s.avg * 0.9 + v * 0.1);
}

export function noteCount(group, name, delta = 1) {
  if (!group || !name) return;
  const s = getStat(group, name);
  s.last = Math.max(0, (s.last || 0) + (delta | 0));
  s.count++;
}

export function getPerfSnapshot(group) {
  const g = _stats.get(group);
  if (!g) return null;
  const out = {};
  for (const [name, s] of g.entries()) {
    out[name] = { last: s.last, avg: s.avg, count: s.count };
  }
  return out;
}
