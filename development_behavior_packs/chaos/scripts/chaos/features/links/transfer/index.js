// scripts/chaos/features/links/transfer/index.js
export { createTransferPathfinder } from "./pathfinding/pathfinder.js";
export { createNetworkTransferController } from "./runtime/controller.js";

// Shared module registry for startup checks.
export const linksModuleList = [
  "config",
  "runtime/controller",
  "keys",
  "utils",
  "pathfinding/graph",
  "pathfinding/path",
  "pathfinding/pathfinder",
  "pathfinding/routes",
  "inventory/inventory",
  "inventory/filters",
  "inventory/reservations",
  "persistence/storage",
  "persistence/inflight",
  "core/cache",
  "systems/levels",
  "systems/fx",
  "beam/config",
  "beam/storage",
  "beam/axis",
  "beam/validation",
  "beam/queue",
  "beam/rebuild",
  "beam/events",
];

export function getLinksModuleStatus() {
  const total = linksModuleList.length;
  return { loaded: total, total };
}
