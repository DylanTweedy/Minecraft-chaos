// scripts/chaos/features/logistics/beam/axis.js
import { AXIS_X, AXIS_Y, AXIS_Z } from "./config.js";

// IMPORTANT: axis mapping is SWAPPED to match authored geometry for horizontal.
// - Rays along +/-X need axis "z"
// - Rays along +/-Z need axis "x"
// Vertical rays use "y".
export function axisForDir(dx, dy, dz) {
  if (dy !== 0) return AXIS_Y;

  if (Math.abs(dx) > Math.abs(dz)) return AXIS_Z; // X-direction -> "z"
  if (Math.abs(dz) > Math.abs(dx)) return AXIS_X; // Z-direction -> "x"
  return AXIS_X;
}

export function beamDirsForAxis(axis) {
  if (axis === AXIS_Y) return [{ dx: 0, dy: 1, dz: 0 }, { dx: 0, dy: -1, dz: 0 }];
  if (axis === AXIS_X) return [{ dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 }];
  if (axis === AXIS_Z) return [{ dx: 1, dy: 0, dz: 0 }, { dx: -1, dy: 0, dz: 0 }];
  return [{ dx: 0, dy: 0, dz: 1 }, { dx: 0, dy: 0, dz: -1 }];
}

export function getBeamAxis(block) {
  try {
    const axis = block?.permutation?.getState("chaos:axis");
    if (axis === AXIS_X || axis === AXIS_Y || axis === AXIS_Z) return axis;
  } catch (e) {
    // ignore
  }
  return AXIS_X;
}

export function beamAxisMatchesDir(block, dx, dy, dz) {
  const axis = getBeamAxis(block);
  return axis === axisForDir(dx, dy, dz);
}

