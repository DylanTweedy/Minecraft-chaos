// scripts/chaos/features/logistics/persistence/serializers.js

export function safeJsonParse(raw, fallback = null) {
  try {
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return null;
  }
}

