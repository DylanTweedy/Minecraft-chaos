// scripts/chaos/bootstrap/bootChaos.js
// Safe bootstrap: no DP at import-time; everything runs after startup tick.

export function bootChaos(deps) {
  try {
    const {
      world,
      system,
    } = deps;
    // Startup messages are now consolidated in startChaos
  } catch {
    // If bootstrap fails, do nothing — better silent than crash.
  }
}
