// scripts/chaos/bootstrap/index.js
import { bootChaos } from "./bootChaos.js";
import { startSystems } from "./startSystems.js";
import "../wandBeam.js";
import "../beamMover.js";

import { registerScript, markScriptLoaded, notifyPlayers } from "../core/scriptLoader.js";
import { isDevModeEnabled } from "../core/debugGroups.js";

import {
  registerMagicMirrorComponent,
  registerDeathmarkComponent,
  registerInsightLensComponent,
  registerInsightGogglesComponent,
} from "./components.js";

import {
  handleMirrorUse,
  handleMirrorUseOn,
  handleMirrorEntityAttack,
} from "../features/magicMirror.js";

import { startTransferLoop } from "./transferLoop.js";
import { fxTransferItem } from "../fx/fx.js";
// import { FX } from "../fx/fxConfig.js"; // TODO: Investigate if FX config is still required/used elsewhere.
import { makeTransferFx } from "../fx/presets.js";

const MIRROR_ID = "chaos:magic_mirror";

let __started = false;

function chat(world, msg) {
  try { world?.sendMessage(msg); } catch {}
}

function prefix(msg) {
  return `§8[§dChaos§8]§r ${msg}`;
}

function fmtErr(err, maxStackChars = 900) {
  const msg = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack) : "";
  if (!stack) return msg;
  const trimmed = stack.length > maxStackChars ? stack.slice(0, maxStackChars) + "…" : stack;
  return `${msg}\n§7${trimmed}§r`;
}

function runStep({ world, DEV_MODE, name, fn, devDetails }) {
  registerScript(name);

  chat(
    world,
    prefix(`§b…§r ${name}${DEV_MODE && devDetails ? ` §7${devDetails}§r` : ""}`)
  );

  try {
    fn();
    markScriptLoaded(name);
    chat(world, prefix(`§a✓§r ${name}`));
    return true;
  } catch (err) {
    chat(world, prefix(`§c✗§r ${name}`));
    chat(world, `§c${fmtErr(err)}`);
    return false;
  }
}

export function startChaos(ctx) {
  const { world, system } = ctx || {};
  if (!world) throw new Error("startChaos(ctx) missing ctx.world");
  if (!system) throw new Error("startChaos(ctx) missing ctx.system");

  if (__started) {
    chat(world, prefix("§e!§r startChaos called again; ignoring (already started)."));
    return;
  }
  __started = true;

  const DEV_MODE = isDevModeEnabled();

  chat(world, prefix(`§a✓§r startChaos() called${DEV_MODE ? " §7(DEV_MODE on)§r" : ""}`));

  // PHASE 1: Foundation
  runStep({
    world,
    DEV_MODE,
    name: "Foundation: Start Systems",
    devDetails: "scriptLoader, fxQueue, beamSim, crystallizer, prestige, etc.",
    fn: () => startSystems({ world, system }),
  });

  // PHASE 2: Boot
  runStep({
    world,
    DEV_MODE,
    name: "Boot: World State",
    devDetails: "boot tasks (currently no-op placeholder)",
    fn: () => bootChaos({ world, system }),
  });

  // PHASE 3: Core Runtime
  runStep({
    world,
    DEV_MODE,
    name: "Core: Transfer Loop",
    devDetails: "network transfers + visuals",
    fn: () => {
      const transferFx = makeTransferFx();
      startTransferLoop({ world, system, fxTransferItem, FX: transferFx });
    },
  });

  // PHASE 4: Components
  runStep({
    world,
    DEV_MODE,
    name: "Components: Magic Mirror",
    fn: () => registerMagicMirrorComponent({
      system,
      world,
      MIRROR_ID,
      handleMirrorUse,
      handleMirrorUseOn,
      handleMirrorEntityAttack,
    }),
  });

  runStep({
    world,
    DEV_MODE,
    name: "Components: Deathmark",
    fn: () => registerDeathmarkComponent(system),
  });

  runStep({
    world,
    DEV_MODE,
    name: "Components: Insight Lens",
    fn: () => registerInsightLensComponent({ system, world }),
  });

  runStep({
    world,
    DEV_MODE,
    name: "Components: Insight Goggles",
    fn: () => registerInsightGogglesComponent({ system }),
  });

  // PHASE 5: Notify
  system.runTimeout(() => {
    try {
      if (DEV_MODE && typeof notifyPlayers === "function") notifyPlayers();
      chat(world, prefix("§a✓§r Systems loaded and ready"));
    } catch {}
  }, 30);
}
