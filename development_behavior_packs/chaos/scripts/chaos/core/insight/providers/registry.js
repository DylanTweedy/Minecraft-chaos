// scripts/chaos/core/insight/providers/registry.js

const _heldProviders = [];
const _focusProviders = [];
let _fallbackProvider = null;

export function registerHeldProvider(provider) {
  if (provider) _heldProviders.push(provider);
}

export function registerFocusProvider(provider) {
  if (provider) _focusProviders.push(provider);
}

export function setFallbackProvider(provider) {
  _fallbackProvider = provider;
}

export function resolveProvider(ctx) {
  if (ctx?.held) {
    for (const p of _heldProviders) {
      try {
        if (p?.match?.(ctx)) return p;
      } catch {}
    }
  }

  if (ctx?.focus) {
    for (const p of _focusProviders) {
      try {
        if (p?.match?.(ctx)) return p;
      } catch {}
    }
  }

  return _fallbackProvider;
}
