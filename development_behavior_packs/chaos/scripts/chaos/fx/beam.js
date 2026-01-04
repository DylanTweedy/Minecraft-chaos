// scripts/chaos/fx/beam.js
import { drawBeamParticles } from "./fx.js";

function centerBlockLocation(block) {
  return {
    x: block.location.x + 0.5,
    y: block.location.y + 0.5,
    z: block.location.z + 0.5,
  };
}

export function drawBeamBetweenPoints(dimension, from, to, fx, opts) {
  const particleId = opts?.particleId ?? fx?.particleBeam;
  let molang = opts?.molang ?? fx?.beamMolang;
  if (typeof molang === "function") {
    try { molang = molang(); } catch { molang = null; }
  }
  const step = opts?.step ?? fx?.beamStep;
  drawBeamParticles(dimension, from, to, particleId, molang, step);
}

export function drawBeamBetweenBlocks(fromBlock, toBlock, fx, opts) {
  if (!fromBlock || !toBlock) return;
  const dim = fromBlock.dimension;
  if (!dim) return;

  const from = centerBlockLocation(fromBlock);
  const to = centerBlockLocation(toBlock);
  drawBeamBetweenPoints(dim, from, to, fx, opts);
}
