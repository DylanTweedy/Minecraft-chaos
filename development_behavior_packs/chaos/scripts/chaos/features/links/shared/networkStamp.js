// scripts/chaos/features/links/shared/networkStamp.js
// Lightweight in-memory stamp for cache invalidation.

let stamp = 0;

export function bumpNetworkStamp() {
  stamp = (stamp + 1) | 0;
  return stamp;
}

export function getNetworkStamp() {
  return stamp;
}

