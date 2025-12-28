export function spawnBeam(dimension, from, to) {
  const particleId = "minecraft:basic_flame_particle";
  const steps = 6;
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const location = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    };
    dimension.spawnParticle(particleId, location);
  }
}
