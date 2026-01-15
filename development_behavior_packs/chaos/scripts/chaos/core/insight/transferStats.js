// scripts/chaos/core/insight/transferStats.js

const _global = {
  inflight: 0,
  queues: 0,
  queuedContainers: 0,
  queuedItems: 0,
  scanMs: 0,
  persistMs: 0,
  tickMs: 0,
  inputQueuesMs: 0,
  pathfindLastMs: 0,
  pathfindTimeouts: 0,
  pathfindErrors: 0,
  watchdog: null,
  watchdogTick: 0,
};

export function noteGlobalQueues({ queues = 0, queuedContainers = 0, queuedItems = 0 } = {}) {
  _global.queues = Math.max(0, queues | 0);
  _global.queuedContainers = Math.max(0, queuedContainers | 0);
  _global.queuedItems = Math.max(0, queuedItems | 0);
}

export function noteGlobalInflight(count) {
  _global.inflight = Math.max(0, count | 0);
}

export function noteGlobalPerf(name, ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (name === "scan") _global.scanMs = v;
  if (name === "persist") _global.persistMs = v;
  if (name === "tick") _global.tickMs = v;
  if (name === "inputQueues") _global.inputQueuesMs = v;
}

export function noteGlobalPathfind(ms, status = "ok") {
  const v = Math.max(0, Number(ms) || 0);
  _global.pathfindLastMs = v;
  if (status === "timeout") _global.pathfindTimeouts++;
  if (status === "error") _global.pathfindErrors++;
}

export function noteWatchdog(level, text, nowTick = 0) {
  if (!text) return;
  _global.watchdog = `[${level}] ${String(text)}`;
  _global.watchdogTick = nowTick | 0;
}

export function getGlobalSummaryMessages() {
  const lines = [];

  lines.push({
    text: `Inflight ${_global.inflight} | Queues ${_global.queues} (${_global.queuedContainers}c/${_global.queuedItems}i)`,
    dedupeKey: `transfer:counts:${_global.inflight}:${_global.queues}:${_global.queuedContainers}:${_global.queuedItems}`,
    category: "transfer",
  });

  lines.push({
    text: `Tick ${_global.tickMs}ms | Scan ${_global.scanMs}ms | Persist ${_global.persistMs}ms`,
    dedupeKey: `transfer:timing:${_global.tickMs}:${_global.scanMs}:${_global.persistMs}`,
    category: "perf",
  });

  if (_global.inputQueuesMs > 0) {
    lines.push({
      text: `InputQueues ${_global.inputQueuesMs}ms`,
      dedupeKey: `transfer:inputQueues:${_global.inputQueuesMs}`,
      category: "perf",
    });
  }

  if (_global.pathfindTimeouts > 0 || _global.pathfindErrors > 0) {
    lines.push({
      text: `Pathfind last=${_global.pathfindLastMs}ms timeouts=${_global.pathfindTimeouts} errors=${_global.pathfindErrors}`,
      dedupeKey: `transfer:pathfind:${_global.pathfindLastMs}:${_global.pathfindTimeouts}:${_global.pathfindErrors}`,
      category: "path",
    });
  }

  if (_global.watchdog) {
    lines.push({
      text: `Watchdog ${_global.watchdog}`,
      dedupeKey: `transfer:watchdog:${_global.watchdog}:${_global.watchdogTick}`,
      category: "risk",
    });
  }

  return lines;
}

export function getGlobalSummaryLabel() {
  return "Network";
}
