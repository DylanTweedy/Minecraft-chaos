// scripts/chaos/bootstrap/startSystems.js

import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startBeamSimV0 } from "../features/links/beamSim.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";
import { startCrystallizerSystem } from "../crystallizer.js";
import { startPrestigeSystem } from "../prestige.js";
import { startDeathmarkSystem } from "../deathmark.js";
import { startInsightObservation } from "../systems/insightObservation.js";

import {
  initializeScriptLoader,
  registerScript,
  markScriptLoaded,
  notifyPlayers,
  startPlayerJoinNotifier,
} from "../core/scriptLoader.js";

import { loadDebugSettings } from "../core/debugGroups.js";

// ─────────────────────────────────────────────────────────────
// Chat-only logging helpers (future Insight Lens routing point)
// ─────────────────────────────────────────────────────────────
function chat(world, msg) {
  try { world?.sendMessage(msg); } catch {}
}

function fmtErr(err, maxStackChars = 900) {
  const msg = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack) : "";
  if (!stack) return msg;

  const trimmed = stack.length > maxStackChars
    ? stack.slice(0, maxStackChars) + "…"
    : stack;

  return `${msg}\n§7${trimmed}§r`;
}

function runSystem({ world, name, fn }) {
  registerScript(name);
  chat(world, `§8[§dChaos§8]§r §b…§r ${name}`);

  try {
    fn();
    markScriptLoaded(name);
    chat(world, `§8[§dChaos§8]§r §a✓§r ${name}`);
    return true;
  } catch (err) {
    chat(world, `§8[§dChaos§8]§r §c✗§r ${name}`);
    chat(world, `§c${fmtErr(err)}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────
export function startSystems({ world, system }) {
  if (!world) throw new Error("startSystems missing world");
  if (!system) throw new Error("startSystems missing system");

  // 1) Initialize ScriptLoader first
  initializeScriptLoader(world, system);

  // 2) Load persistent debug settings shortly after startup
  system.runTimeout(() => {
    try {
      loadDebugSettings();
      chat(world, "§8[§dChaos§8]§r §a✓§r Debug settings loaded");
    } catch (err) {
      chat(world, "§8[§dChaos§8]§r §e!§r Debug settings load failed");
      chat(world, `§c${fmtErr(err)}`);
    }
  }, 1);

  // 3) Declare systems in explicit startup order
  const systems = [
    { name: "FX Queue", fn: () => startFxQueue() },
    { name: "Cleanup on Break", fn: () => startCleanupOnBreak() },
    { name: "Filter Interact", fn: () => startFilterInteract() },
    { name: "Beam Simulation", fn: () => startBeamSimV0() },
    { name: "Crystallizer", fn: () => startCrystallizerSystem() },
    { name: "Prestige", fn: () => startPrestigeSystem() },
    { name: "Deathmark System", fn: () => startDeathmarkSystem(world, system) },
    { name: "Insight Observation", fn: () => startInsightObservation() },
  ];

  for (const sys of systems) {
    runSystem({ world, ...sys });
  }

  // 4) Player join notifier
  try {
    startPlayerJoinNotifier();
  } catch (err) {
    chat(world, "§8[§dChaos§8]§r §e!§r Player join notifier failed");
    chat(world, `§c${fmtErr(err)}`);
  }

  // 5) Notify existing players after reload
  system.runTimeout(() => {
    try {
      notifyPlayers();
    } catch (err) {
      chat(world, "§8[§dChaos§8]§r §e!§r notifyPlayers failed");
      chat(world, `§c${fmtErr(err)}`);
    }
  }, 40);
}
