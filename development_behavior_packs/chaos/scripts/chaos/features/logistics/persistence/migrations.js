// scripts/chaos/features/logistics/persistence/migrations.js
import { DP_LOGISTICS_SCHEMA } from "./dpKeys.js";

const SCHEMA_VERSION = 1;

export function runMigrations(world) {
  if (!world) return;
  try {
    const current = world.getDynamicProperty(DP_LOGISTICS_SCHEMA);
    const parsed = typeof current === "number" ? current : 0;
    if (parsed >= SCHEMA_VERSION) return;
    world.setDynamicProperty(DP_LOGISTICS_SCHEMA, SCHEMA_VERSION);
  } catch (e) {
    // ignore migration errors
  }
}

export { SCHEMA_VERSION };

