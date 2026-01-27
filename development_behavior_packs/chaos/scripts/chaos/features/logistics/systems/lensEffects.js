// scripts/chaos/features/logistics/systems/lensEffects.js

export const LENS_EFFECTS = Object.freeze({
  white: "regeneration",
  orange: "fire_resistance",
  magenta: "levitation",
  light_blue: "slow_falling",
  yellow: "haste",
  lime: "speed",
  pink: "health_boost",
  gray: "resistance",
  light_gray: "night_vision",
  cyan: "water_breathing",
  purple: "jump_boost",
  blue: "conduit_power",
  brown: "strength",
  green: "poison",
  red: "weakness",
  black: "blindness",
});

export function getLensEffect(color) {
  if (!color || typeof color !== "string") return null;
  return LENS_EFFECTS[color] || null;
}
