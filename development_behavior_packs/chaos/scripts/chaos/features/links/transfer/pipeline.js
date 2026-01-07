// scripts/chaos/features/links/transfer/pipeline.js
export function runTransferPipeline(steps, ctx) {
  if (!Array.isArray(steps) || steps.length === 0) return;
  for (const step of steps) {
    if (typeof step === "function") step(ctx);
  }
}
