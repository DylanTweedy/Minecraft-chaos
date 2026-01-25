// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveResult.js

export const ResolveKinds = Object.freeze({
  ATTUNED: "attuned",
  CRYSTALLIZER: "crystallizer",
  CRUCIBLE: "crucible",
  DRIFT: "drift",
  NONE: "none",
});

export function makeResolveResult(kind, data = {}) {
  if (typeof kind !== "string") {
    return Object.freeze({ kind: ResolveKinds.NONE });
  }
  const key = kind.toUpperCase();
  if (!ResolveKinds[key]) {
    return Object.freeze({ kind: ResolveKinds.NONE });
  }
  return Object.freeze({ kind, ...data });
}
