// scripts/chaos/bootstrap/startSystems.js

import { startCleanupOnBreak } from "../systems/cleanupOnBreak.js";
import { startFxQueue } from "../systems/fxQueue.js";
import { startFilterInteract } from "../systems/filterInteract.js";
import { startFoundryInteract } from "../systems/foundryInteract.js";
import { startCollectorInteract } from "../systems/collectorInteract.js";
import { startCrystallizerSystem } from "../crystallizer.js";
import { startPrestigeSystem } from "../prestige.js";
import { startDeathmarkSystem } from "../deathmark.js";
import { startInsightRouter } from "../core/insight/router.js";
import { startTransposerSystem } from "../features/transposer/transposerSystem.js";
import { startCollectorSystem } from "../features/logistics/collector.js";

import {
  initializeScriptLoader,
  registerScript,
  markScriptLoaded,
  notifyPlayers,
  startPlayerJoinNotifier,
} from "../core/scriptLoader.js";


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Chat-only logging helpers (future Insight Lens routing point)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function chat(world, msg) {
  try { world?.sendMessage(msg); } catch {}
}

function fmtErr(err, maxStackChars = 900) {
  const msg = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack) : "";
  if (!stack) return msg;

  const trimmed = stack.length > maxStackChars
    ? stack.slice(0, maxStackChars) + "â€¦"
    : stack;

  return `${msg}\nÂ§7${trimmed}Â§r`;
}

function runSystem({ world, name, fn }) {
  registerScript(name);
  chat(world, `Â§8[Â§dChaosÂ§8]Â§r Â§bâ€¦Â§r ${name}`);

  try {
    fn();
    markScriptLoaded(name);
    chat(world, `Â§8[Â§dChaosÂ§8]Â§r Â§aâœ“Â§r ${name}`);
    return true;
  } catch (err) {
    chat(world, `Â§8[Â§dChaosÂ§8]Â§r Â§câœ—Â§r ${name}`);
    chat(world, `Â§c${fmtErr(err)}`);
    return false;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Entry point
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function startSystems({ world, system }) {
  if (!world) throw new Error("startSystems missing world");
  if (!system) throw new Error("startSystems missing system");

  // 1) Initialize ScriptLoader first
  initializeScriptLoader(world, system);
  // 2) Declare systems in explicit startup order
  const systems = [
    { name: "FX Queue", fn: () => startFxQueue() },
    { name: "Cleanup on Break", fn: () => startCleanupOnBreak() },
    { name: "Filter Interact", fn: () => startFilterInteract() },
    { name: "Foundry Interact", fn: () => startFoundryInteract() },
    { name: "Collector Interact", fn: () => startCollectorInteract() },
    { name: "Crystallizer", fn: () => startCrystallizerSystem() },
    { name: "Prestige", fn: () => startPrestigeSystem() },
    { name: "Deathmark System", fn: () => startDeathmarkSystem(world, system) },
    { name: "Insight Router", fn: () => startInsightRouter() },
    { name: "Transposer System", fn: () => startTransposerSystem() },
    { name: "Collector", fn: () => startCollectorSystem() },
  ];

  for (const sys of systems) {
    runSystem({ world, ...sys });
  }

  // 3) Player join notifier
  try {
    startPlayerJoinNotifier();
  } catch (err) {
    chat(world, "Â§8[Â§dChaosÂ§8]Â§r Â§e!Â§r Player join notifier failed");
    chat(world, `Â§c${fmtErr(err)}`);
  }

  // 4) Notify existing players after reload
  system.runTimeout(() => {
    try {
      notifyPlayers();
    } catch (err) {
      chat(world, "Â§8[Â§dChaosÂ§8]Â§r Â§e!Â§r notifyPlayers failed");
      chat(world, `Â§c${fmtErr(err)}`);
    }
  }, 40);
}

