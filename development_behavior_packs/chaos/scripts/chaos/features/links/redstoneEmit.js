// scripts/chaos/redstoneEmit.js
import { world, system } from "@minecraft/server";
import { emitBeamFromInputBlock } from "./beamSim.js";
import { makeKeyFromBlock } from "./keys.js";

const INPUT_ID = "chaos:input_node";

const CHECKS_PER_TICK = 24;  // budget
let knownInputs = new Set(); // keys
let rr = 0;

const lastPowered = new Map(); // key -> boolean

function safeGetBlockByKey(key) {
  // key format: dim|x,y,z (matches your system)
  try {
    const bar = key.indexOf("|");
    if (bar === -1) return null;
    const dimId = key.slice(0, bar);
    const rest = key.slice(bar + 1);
    const [x, y, z] = rest.split(",").map((n) => Number(n));
    if (![x, y, z].every(Number.isFinite)) return null;

    const dim = world.getDimension(dimId);
    return dim.getBlock({ x, y, z });
  } catch {
    return null;
  }
}

function isPowered(block) {
  try {
    if (!block) return false;

    // Try common redstone component patterns
    const c1 = block.getComponent?.("minecraft:redstone_signal");
    if (c1 && typeof c1.power === "number") return c1.power > 0;

    const c2 = block.getComponent?.("minecraft:redstone");
    if (c2 && typeof c2.power === "number") return c2.power > 0;

    // Fallback: check permutation states some blocks expose
    const p = block.permutation;
    if (p?.getState) {
      const s = p.getState("minecraft:redstone_signal");
      if (typeof s === "number") return s > 0;
      const s2 = p.getState("minecraft:powered");
      if (typeof s2 === "boolean") return s2;
    }
  } catch {
    // ignore
  }
  return false;
}

export function registerInputBlock(block) {
  try {
    if (!block || block.typeId !== INPUT_ID) return;
    const k = makeKeyFromBlock(block);
    if (!k) return;
    knownInputs.add(k);
  } catch {}
}

export function unregisterInputBlock(block) {
  try {
    if (!block) return;
    const k = makeKeyFromBlock(block);
    if (!k) return;
    knownInputs.delete(k);
    lastPowered.delete(k);
  } catch {}
}

export function startRedstoneBeamEmit() {
  system.runInterval(() => {
    if (knownInputs.size === 0) return;

    const keys = Array.from(knownInputs);
    const n = keys.length;

    let budget = CHECKS_PER_TICK;
    while (budget-- > 0 && n > 0) {
      if (rr >= n) rr = 0;
      const k = keys[rr++];

      const b = safeGetBlockByKey(k);

      // If block vanished or changed type, drop it
      if (!b || b.typeId !== INPUT_ID) {
        knownInputs.delete(k);
        lastPowered.delete(k);
        continue;
      }

      const now = isPowered(b);
      const prev = lastPowered.get(k) ?? false;

      if (now && !prev) {
        // Rising edge: emit once
        emitBeamFromInputBlock(b);
      }

      lastPowered.set(k, now);
    }
  }, 1);
}
