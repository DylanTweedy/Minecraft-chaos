// scripts/chaos/features/logistics/runtime/pipeline.js

export function createTransferPipeline(opts = {}) {
  const phases = Array.isArray(opts.phases) ? opts.phases : [];
  const pipelineName = String(opts.name || "TransferPipeline");

  function safeNow() {
    return Date.now();
  }

  function ensureMetrics(ctx) {
    if (!ctx) return null;
    if (!ctx.metrics || typeof ctx.metrics !== "object") {
      ctx.metrics = { phases: {}, counters: {}, notes: [] };
    }
    return ctx.metrics;
  }

  function bumpCounter(ctx, name, delta = 1) {
    const metrics = ensureMetrics(ctx);
    if (!metrics) return;
    metrics.counters[name] = (metrics.counters[name] || 0) + (delta | 0);
  }

  function note(ctx, text) {
    const metrics = ensureMetrics(ctx);
    if (!metrics || !Array.isArray(metrics.notes)) return;
    if (metrics.notes.length < 50) metrics.notes.push(String(text || ""));
  }

  function phaseMetric(ctx, phaseName, fields) {
    const metrics = ensureMetrics(ctx);
    if (!metrics) return;
    const entry = (metrics.phases[phaseName] ||= { ms: 0, calls: 0, stops: 0, errors: 0 });
    if (fields?.ms) entry.ms += fields.ms;
    if (fields?.calls) entry.calls += fields.calls;
    if (fields?.stops) entry.stops += fields.stops;
    if (fields?.errors) entry.errors += fields.errors;
  }


  function trace(ctx, msg, key) {
    if (!ctx || typeof ctx.emitTrace !== "function") return;
    ctx.emitTrace(null, "transfer", {
      text: `[Trace] ${String(msg || "")}`,
      category: "transfer",
    });
  }

  function runTick(ctx) {
    const metrics = ensureMetrics(ctx);
    const tickStart = ctx?.tickStart || safeNow();
    let stopped = false;
    let stopReason = "ok";

    for (const phase of phases) {
      if (!phase || typeof phase.run !== "function") continue;
      const name = String(phase.name || "phase");
      const t0 = safeNow();
      phaseMetric(ctx, name, { calls: 1 });

      let result;
      try {
        result = phase.run(ctx) || undefined;
      } catch (err) {
        phaseMetric(ctx, name, { errors: 1 });
        bumpCounter(ctx, "phase_errors");
        const message = (err && err.message) ? String(err.message) : String(err || "error");
        note(ctx, `${name}:ERROR:${message}`);
        stopped = true;
        stopReason = `phase_error:${name}`;
        break;
      }

      const dt = safeNow() - t0;
      phaseMetric(ctx, name, { ms: dt });

      const warnMs = phase.warnMs | 0;
      if (warnMs > 0 && dt > warnMs && typeof ctx.noteWatchdog === "function") {
        ctx.noteWatchdog("PERF", `${pipelineName}.${name} ${dt}ms`, ctx?.nowTick | 0);
      }

      const hardStopMs = phase.hardStopMs | 0;
      if (hardStopMs > 0 && dt > hardStopMs) {
        bumpCounter(ctx, "hardstop_phase_ms");
        note(ctx, `${name}:HARDSTOP:${dt}ms`);
        stopped = true;
        stopReason = `hardstop:${name}`;
        break;
      }

      if (result && result.stop) {
        phaseMetric(ctx, name, { stops: 1 });
        stopped = true;
        stopReason = String(result.reason || `stop:${name}`);
        break;
      }

      const elapsed = safeNow() - tickStart;
      ctx.tickElapsedMs = elapsed;
      const softBudget = ctx.softBudgetMs | 0;
      if (softBudget > 0 && elapsed > softBudget) {
        bumpCounter(ctx, "soft_budget_stops");
        note(ctx, `softBudgetStop:${elapsed}ms`);
        stopped = true;
        stopReason = "soft_budget_stop";
        break;
      }
    }

    return { ok: !stopped, stop: stopped, reason: stopReason };
  }

  return { runTick, trace, bumpCounter, note };
}



