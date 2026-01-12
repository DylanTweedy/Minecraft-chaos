// scripts/chaos/features/links/transfer/runtime/helpers/result.js

export function ok(reason = "ok") {
  return { ok: true, reason };
}

export function fail(reason = "fail") {
  return { ok: false, reason };
}

export function phaseStep(ctx, message, opts = {}) {
  const send = ctx?.sendDiagnosticMessage;
  if (typeof send !== "function") return;

  const maxTick = opts.maxTick ?? 3;
  const nowTick = ctx?.nowTick | 0;
  if (maxTick >= 0 && nowTick > maxTick) return;

  const prefix = opts.prefix || "[Phase]";
  send(`${prefix} ${String(message ?? "")}`, "transfer");
}

