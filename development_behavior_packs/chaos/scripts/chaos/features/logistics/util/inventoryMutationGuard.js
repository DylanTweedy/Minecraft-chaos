// scripts/chaos/features/logistics/util/inventoryMutationGuard.js
import { bumpCounter } from "./insightCounters.js";
import { emitPrismReason } from "./insightReasons.js";
import { ReasonCodes } from "./insightReasonCodes.js";

const DEFAULT_COOLDOWN_TICKS = 40;

class InventoryMutationGuard {
  constructor() {
    this.strict = true;
    this.cooldownTicks = DEFAULT_COOLDOWN_TICKS;
    this.depth = 0;
    this.activeContext = null;
    this.lastEmitByKey = new Map();
  }

  configure(cfg) {
    if (!cfg) return;
    if (typeof cfg.strictOrbsOnly === "boolean") this.strict = cfg.strictOrbsOnly;
    const cd = Number(cfg.mutationGuardCooldownTicks);
    if (Number.isFinite(cd) && cd > 0) this.cooldownTicks = cd | 0;
  }

  beginOrbSettlement(ctx, context) {
    this.depth++;
    this.activeContext = context || this.activeContext;
    if (ctx?.cfg) this.configure(ctx.cfg);
  }

  endOrbSettlement() {
    if (this.depth > 0) this.depth--;
    if (this.depth === 0) this.activeContext = null;
  }

  _emitViolation(ctx, info, blocked) {
    if (!ctx) return;
    const nowTick = ctx.nowTick | 0;
    const prismKey = info?.prismKey || info?.sourcePrismKey || info?.destPrismKey || null;
    const phase = info?.phase || info?.tag || "mutation";
    const opName = info?.opName || "mutation";
    const itemTypeId = info?.itemTypeId || "item";
    const key = `${prismKey || "unknown"}|${phase}|${opName}`;
    const last = this.lastEmitByKey.get(key) | 0;
    if (nowTick - last < this.cooldownTicks) return;
    this.lastEmitByKey.set(key, nowTick);

    const code = blocked ? ReasonCodes.ILLEGAL_MUTATION_BLOCKED : ReasonCodes.ILLEGAL_MUTATION_DETECTED;
    const text = blocked
      ? `Mutation blocked (${phase}:${opName})`
      : `Mutation detected (${phase}:${opName})`;
    if (prismKey) {
      emitPrismReason(ctx, prismKey, code, text, { itemTypeId });
    } else {
      emitPrismReason(ctx, "unknown", code, text, { itemTypeId });
    }
  }

  assertMutationAllowed(ctx, info) {
    if (this.depth > 0) return true;
    bumpCounter(ctx, "illegal_mutation_detected");
    if (ctx?.state?.mutationGuard) {
      ctx.state.mutationGuard.lastViolationTick = ctx.nowTick | 0;
    }
    this._emitViolation(ctx, info, false);
    if (!this.strict) return true;
    bumpCounter(ctx, "illegal_mutation_blocked");
    this._emitViolation(ctx, info, true);
    return false;
  }
}

const guardSingleton = new InventoryMutationGuard();

export function getInventoryMutationGuard() {
  return guardSingleton;
}

