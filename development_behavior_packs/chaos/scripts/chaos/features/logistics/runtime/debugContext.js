// scripts/chaos/features/logistics/runtime/debugContext.js

let _services = null;

export function setLogisticsDebugServices(services) {
  _services = services || null;
}

export function getLogisticsDebugServices() {
  return _services;
}
