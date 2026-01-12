// scripts/chaos/features/links/transfer/runtime/helpers/candidates.js

export function rejectCandidate(list, candidate) {
  if (!Array.isArray(list) || !candidate) return;
  const idx = list.indexOf(candidate);
  if (idx >= 0) list.splice(idx, 1);
}

