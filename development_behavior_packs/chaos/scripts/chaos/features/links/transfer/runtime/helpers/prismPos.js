// scripts/chaos/features/links/transfer/runtime/helpers/prismPos.js
import { withDim } from "./pos.js";

export function getPrismPos({ prismKey, prismBlock, dim, prismInfo, resolveBlockInfo }) {
  const prefer = prismBlock?.location || prismInfo?.pos;
  if (prefer) {
    const dimId = dim?.id || prismInfo?.dim?.id || prefer?.dimId;
    return withDim({ ...prefer, dimId }, dimId);
  }

  if (typeof resolveBlockInfo === "function" && prismKey) {
    try {
      const info = resolveBlockInfo(prismKey);
      if (info?.pos) {
        const dimId = info.dim?.id || info.pos.dimId;
        return withDim({ ...info.pos, dimId }, dimId);
      }

      const fallback = info?.block?.location;
      if (fallback) {
        const dimId = info.dim?.id || info.block?.dimension?.id || dim?.id;
        return withDim({ ...fallback, dimId }, dimId);
      }
    } catch {
      // silence
    }
  }

  return null;
}

