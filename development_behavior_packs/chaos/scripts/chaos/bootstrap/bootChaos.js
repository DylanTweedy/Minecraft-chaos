// scripts/chaos/bootstrap/bootChaos.js
// Boot tasks = one-off world initialization (persistence, migrations, cache rebuild).
// Keep this separate from "systems" (long-running loops and subscriptions).

export function bootChaos({ world, system }) {
  if (!world) throw new Error("bootChaos missing world");
  if (!system) throw new Error("bootChaos missing system");

  // TODO: Implement real boot tasks here:
  // - load persistent link data / tiers
  // - rebuild any caches/graphs
  // - migrations / cleanup orphaned saved state
  // - validate placed Chaos blocks

  // Current: no-op by design.
}
