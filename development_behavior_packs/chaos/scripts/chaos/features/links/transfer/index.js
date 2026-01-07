// scripts/chaos/features/links/transfer/index.js
export { createTransferPathfinder } from "./pathfinder.js";
export { createNetworkTransferController } from "./controller.js";

// Shared module registry for startup checks.
export const linksModuleList = [
  "adapter",
  "config",
  "controller",
  "filters",
  "graph",
  "inflight",
  "inventory",
  "keys",
  "path",
  "pathfinder",
  "pipeline",
  "reservations",
  "routes",
  "storage",
  "utils",
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
