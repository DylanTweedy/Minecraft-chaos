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
  const target = ctx?.target;
  if (!target) return null;

  const providers =
    target.type === "item" ? _heldProviders : _focusProviders;

  for (const provider of providers) {
    try {
      if (provider?.match?.(ctx)) return provider;
    } catch {}
  }

  if (_fallbackProvider) {
    try {
      if (typeof _fallbackProvider.match === "function") {
        if (_fallbackProvider.match(ctx)) return _fallbackProvider;
      } else {
        return _fallbackProvider;
      }
    } catch {}
  }

  return null;
}
