// scripts/chaos/features/links/transfer/core/pipeline.js

/**
 * A tiny, safe "phase runner" for your transfer tick.
 * - Makes controller orchestration clean.
 * - Captures per-phase timing + counters.
 * - Supports "trace" output for a single focused key (e.g. prismKey) driven by Insight Lens/Goggles UI.
 *
 * Philosophy: phases do the work, pipeline just coordinates + observes.
 */

/**
 * @typedef {Object} PhaseResult
 * @property {boolean=} ok
 * @property {boolean=} stop        // stop further phases this tick (early return)
 * @property {string=} reason       // optional reason label (for metrics)
 */

/**
 * @typedef {Object} Phase
 * @property {string} name
 * @property {(ctx: any) => (PhaseResult|void)} run
 * @property {number=} warnMs       // warn if phase time exceeds this
 * @property {number=} hardStopMs   // if exceeded, request stop to avoid watchdog
 */

/**
 * Create a pipeline runner.
 * @param {Object} opts
 * @param {Phase[]} opts.phases
 * @param {string=} opts.name
 * @returns {{ runTick: (ctx: any) => PhaseResult }}
 */
export function createTransferPipeline(opts) {
  const phases = Array.isArray(opts?.phases) ? opts.phases : [];
  const pipelineName = String(opts?.name || "TransferPipeline");

  function safeNow() {
    // Date.now is fine here; keep this as a hook if you ever want system.currentTick based timing.
    return Date.now();
  }

  function ensureMetrics(ctx) {
    if (!ctx.metrics || typeof ctx.metrics !== "object") ctx.metrics = {};
    const m = ctx.metrics;

    if (!m.phases || typeof m.phases !== "object") m.phases = {}; // { [phaseName]: { ms, calls, stops, errors } }
    if (!m.counters || typeof m.counters !== "object") m.counters = {}; // free-form counters
    if (!m.notes || !Array.isArray(m.notes)) m.notes = []; // rare events
    return m;
  }

  function bumpCounter(ctx, name, delta = 1) {
    const m = ensureMetrics(ctx);
    m.counters[name] = (m.counters[name] || 0) + (delta | 0);
  }

  function note(ctx, text) {
    const m = ensureMetrics(ctx);
    if (m.notes.length < 50) m.notes.push(String(text || ""));
  }

  function phaseMetric(ctx, phaseName, fields) {
    const m = ensureMetrics(ctx);
    const p = (m.phases[phaseName] ||= { ms: 0, calls: 0, stops: 0, errors: 0 });
    if (fields?.ms) p.ms += fields.ms;
    if (fields?.calls) p.calls += fields.calls;
    if (fields?.stops) p.stops += fields.stops;
    if (fields?.errors) p.errors += fields.errors;
  }

  function shouldTrace(ctx, prismKey) {
    // Trace is controlled externally (Insight Lens/Goggles UI should set ctx.traceKey or similar).
    // Keep this generic so you can later trace output nodes / blocks too.
    const traceKey = ctx?.traceKey;
    if (!traceKey) return false;
    return String(traceKey) === String(prismKey);
  }

  function trace(ctx, msg, prismKey) {
    try {
      if (!ctx || typeof ctx.sendDiagnosticMessage !== "function") return;
      if (prismKey != null && !shouldTrace(ctx, prismKey)) return;

      // Only send trace if the player has insight enabled (your UI logic should decide this).
      // This is intentionally soft: ctx.canTrace can be toggled by controller based on hasInsight/isHoldingLens/isWearingGoggles.
      if (ctx.canTrace === false) return;

      ctx.sendDiagnosticMessage(`§7[Trace] ${String(msg || "")}`, "transfer");
    } catch {
      // Never throw from trace.
    }
  }

  /**
   * Run one tick through all phases.
   * @param {any} ctx
   * @returns {PhaseResult}
   */
  function runTick(ctx) {
    ensureMetrics(ctx);

    let stopped = false;
    let stopReason = "ok";

    // A small watchdog-minded guard: if ctx.tickStart exists, we can skip expensive phases later.
    const tickStart = ctx?.tickStart || safeNow();

    for (const ph of phases) {
      if (!ph || typeof ph.run !== "function") continue;

      const phaseName = String(ph.name || "phase");
      const t0 = safeNow();
      phaseMetric(ctx, phaseName, { calls: 1 });

      let res;
      try {
        res = ph.run(ctx) || undefined;
      } catch (err) {
        phaseMetric(ctx, phaseName, { errors: 1 });
        bumpCounter(ctx, "phase_errors", 1);

        const msg = (err && err.message) ? String(err.message) : String(err || "unknown error");
        note(ctx, `${phaseName}:ERROR:${msg}`);

        // Let controller decide if it wants to hard-disable; pipeline just requests stop.
        stopped = true;
        stopReason = `phase_error:${phaseName}`;
        break;
      }

      const dt = safeNow() - t0;
      phaseMetric(ctx, phaseName, { ms: dt });

      // Optional warnings
      const warnMs = (ph.warnMs | 0) || 0;
      if (warnMs > 0 && dt > warnMs && typeof ctx.sendDiagnosticMessage === "function") {
        ctx.sendDiagnosticMessage(`§e[PERF] ${pipelineName}.${phaseName}: ${dt}ms`, "transfer");
      }

      // Optional hard stop if phase was too slow
      const hardStopMs = (ph.hardStopMs | 0) || 0;
      if (hardStopMs > 0 && dt > hardStopMs) {
        bumpCounter(ctx, "hardstop_phase_ms", 1);
        note(ctx, `${phaseName}:HARDSTOP:${dt}ms`);
        stopped = true;
        stopReason = `hardstop:${phaseName}`;
        break;
      }

      if (res && res.stop) {
        phaseMetric(ctx, phaseName, { stops: 1 });
        stopped = true;
        stopReason = String(res.reason || `stop:${phaseName}`);
        break;
      }

      // Safety: If we’re already taking too long, allow ctx to request phase skipping.
      const elapsed = safeNow() - tickStart;
      ctx.tickElapsedMs = elapsed;

      // (Controller can set ctx.softBudgetMs; pipeline will enforce a stop to avoid watchdog)
      const softBudgetMs = (ctx.softBudgetMs | 0) || 0;
      if (softBudgetMs > 0 && elapsed > softBudgetMs) {
        bumpCounter(ctx, "soft_budget_stops", 1);
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
