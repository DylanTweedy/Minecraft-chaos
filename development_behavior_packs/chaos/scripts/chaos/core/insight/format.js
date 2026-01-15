// scripts/chaos/core/insight/format.js

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildChatHash(lines) {
  return stableStringify(lines || []);
}

export function dedupeMessages(messages) {
  const out = [];
  const seen = new Set();
  for (const msg of messages || []) {
    if (!msg) continue;
    const key = msg.dedupeKey || msg.text || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(msg);
  }
  return out;
}

function formatLine(msg) {
  const icon = msg.icon ? `[${msg.icon}] ` : "";
  const category = msg.category ? `[${msg.category}] ` : "";
  const text = msg.text ? String(msg.text) : "";
  return `- ${icon}${category}${text}`.trim();
}

export function formatBatch(contextLabel, messages) {
  const label = contextLabel ? String(contextLabel) : "Insight";
  const lines = [`[INSIGHT+] ${label}`];
  for (const msg of messages || []) {
    lines.push(formatLine(msg));
  }
  return lines.join("\n");
}
