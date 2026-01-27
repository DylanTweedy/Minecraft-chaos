// scripts/chaos/bootstrap/index.js

const MIRROR_ID = "chaos:magic_mirror";
const TRANSPOSER_TUNER_ID = "chaos:teleporter_tuner";

let __started = false;
let __modulesLoaded = false;
let __modulesLoading = null;

let bootChaos = null;
let startSystems = null;
let initAutoElytraSwap = null;
let initEffectsLab = null;
let registerScript = null;
let markScriptLoaded = null;
let notifyPlayers = null;
let registerMagicMirrorComponent = null;
let registerDeathmarkComponent = null;
let registerInsightLensComponent = null;
let registerInsightGogglesComponent = null;
let registerTransposerTunerComponent = null;
let handleMirrorUse = null;
let handleMirrorUseOn = null;
let handleMirrorEntityAttack = null;
let startTransferLoop = null;
let fxTransferItem = null;
let makeTransferFx = null;
let handleTransposerTunerUseOn = null;
let handleTransposerTunerUse = null;

const IMPORTS = [
  { path: "./bootChaos.js", assign: (m) => { bootChaos = m.bootChaos; } },
  { path: "./startSystems.js", assign: (m) => { startSystems = m.startSystems; } },
  { path: "../wandBeam.js" },
  { path: "../beamMove.js" },
  { path: "../features/armor/autoElytraSwap.js", assign: (m) => { initAutoElytraSwap = m.initAutoElytraSwap; } },
  { path: "../dev/effectsLab.js", assign: (m) => { initEffectsLab = m.initEffectsLab; } },
  { path: "../core/scriptLoader.js", assign: (m) => {
      registerScript = m.registerScript;
      markScriptLoaded = m.markScriptLoaded;
      notifyPlayers = m.notifyPlayers;
    }
  },
  { path: "./components.js", assign: (m) => {
      registerMagicMirrorComponent = m.registerMagicMirrorComponent;
      registerDeathmarkComponent = m.registerDeathmarkComponent;
      registerInsightLensComponent = m.registerInsightLensComponent;
      registerInsightGogglesComponent = m.registerInsightGogglesComponent;
      registerTransposerTunerComponent = m.registerTransposerTunerComponent;
    }
  },
  { path: "../features/magicMirror.js", assign: (m) => {
      handleMirrorUse = m.handleMirrorUse;
      handleMirrorUseOn = m.handleMirrorUseOn;
      handleMirrorEntityAttack = m.handleMirrorEntityAttack;
    }
  },
  { path: "./transferLoop.js", assign: (m) => { startTransferLoop = m.startTransferLoop; } },
  { path: "../fx/fx.js", assign: (m) => { fxTransferItem = m.fxTransferItem; } },
  { path: "../fx/presets.js", assign: (m) => { makeTransferFx = m.makeTransferFx; } },
  { path: "../features/transposer/linking.js", assign: (m) => {
      handleTransposerTunerUseOn = m.handleTransposerTunerUseOn;
      handleTransposerTunerUse = m.handleTransposerTunerUse;
    }
  },
];

function chat(world, msg) {
  try { world?.sendMessage(msg); } catch {}
}

function prefix(msg) {
  return `Â§8[Â§dChaosÂ§8]Â§r ${msg}`;
}

function fmtErr(err, maxStackChars = 900) {
  const msg = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack) : "";
  if (!stack) return msg;
  const trimmed = stack.length > maxStackChars ? stack.slice(0, maxStackChars) + "â€¦" : stack;
  return `${msg}\nÂ§7${trimmed}Â§r`;
}

function requireSymbol(world, name, value, source) {
  if (value) return true;
  chat(world, prefix(`Â§câœ—Â§r Missing export: ${name}`));
  chat(world, prefix(`Â§eHintÂ§r`, `Expected ${name} from ${source}`));
  return false;
}

async function loadBootstrapModules(world) {
  if (__modulesLoaded) return true;
  if (__modulesLoading) return __modulesLoading;

  __modulesLoading = (async () => {
    for (const entry of IMPORTS) {
      try {
        const mod = await import(entry.path);
        if (entry.assign) entry.assign(mod);
      } catch (err) {
        chat(world, prefix(`Â§câœ—Â§r Bootstrap import FAILED: ${entry.path}`));
        chat(world, `Â§c${fmtErr(err)}`);
        return false;
      }
    }

    try {
      if (typeof initAutoElytraSwap === "function") initAutoElytraSwap();
    } catch (err) {
      chat(world, prefix("Â§câœ—Â§r Bootstrap init FAILED: autoElytraSwap"));
      chat(world, `Â§c${fmtErr(err)}`);
      return false;
    }

    try {
      if (typeof initEffectsLab === "function") initEffectsLab();
    } catch (err) {
      chat(world, prefix("Â§câœ—Â§r Bootstrap init FAILED: effectsLab"));
      chat(world, `Â§c${fmtErr(err)}`);
      return false;
    }

    const required = [
      ["bootChaos", bootChaos, "./bootChaos.js"],
      ["startSystems", startSystems, "./startSystems.js"],
      ["registerScript", registerScript, "../core/scriptLoader.js"],
      ["markScriptLoaded", markScriptLoaded, "../core/scriptLoader.js"],
      ["registerMagicMirrorComponent", registerMagicMirrorComponent, "./components.js"],
      ["registerDeathmarkComponent", registerDeathmarkComponent, "./components.js"],
      ["registerInsightLensComponent", registerInsightLensComponent, "./components.js"],
      ["registerInsightGogglesComponent", registerInsightGogglesComponent, "./components.js"],
      ["registerTransposerTunerComponent", registerTransposerTunerComponent, "./components.js"],
      ["handleMirrorUse", handleMirrorUse, "../features/magicMirror.js"],
      ["handleMirrorUseOn", handleMirrorUseOn, "../features/magicMirror.js"],
      ["handleMirrorEntityAttack", handleMirrorEntityAttack, "../features/magicMirror.js"],
      ["startTransferLoop", startTransferLoop, "./transferLoop.js"],
      ["fxTransferItem", fxTransferItem, "../fx/fx.js"],
      ["makeTransferFx", makeTransferFx, "../fx/presets.js"],
      ["handleTransposerTunerUseOn", handleTransposerTunerUseOn, "../features/transposer/linking.js"],
      ["handleTransposerTunerUse", handleTransposerTunerUse, "../features/transposer/linking.js"],
    ];

    for (const [name, value, source] of required) {
      if (!requireSymbol(world, name, value, source)) return false;
    }

    __modulesLoaded = true;
    return true;
  })();

  return __modulesLoading;
}

function runStep({ world, DEV_MODE, name, fn, devDetails }) {
  registerScript(name);

  chat(
    world,
    prefix(`Â§bâ€¦Â§r ${name}${DEV_MODE && devDetails ? ` Â§7${devDetails}Â§r` : ""}`)
  );

  try {
    fn();
    markScriptLoaded(name);
    chat(world, prefix(`Â§aâœ“Â§r ${name}`));
    return true;
  } catch (err) {
    chat(world, prefix(`Â§câœ—Â§r ${name}`));
    chat(world, `Â§c${fmtErr(err)}`);
    return false;
  }
}

export function startChaos(ctx) {
  const { world, system } = ctx || {};
  if (!world) throw new Error("startChaos(ctx) missing ctx.world");
  if (!system) throw new Error("startChaos(ctx) missing ctx.system");

  if (__started) {
    chat(world, prefix("Â§e!Â§r startChaos called again; ignoring (already started)."));
    return;
  }
  __started = true;

  const DEV_MODE = false;

  const run = async () => {
    const ok = await loadBootstrapModules(world);
    if (!ok) return;

    chat(world, prefix(`Â§aâœ“Â§r startChaos() called${DEV_MODE ? " Â§7(DEV_MODE on)Â§r" : ""}`));

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

    runStep({
      world,
      DEV_MODE,
      name: "Components: Transposer Tuner",
      fn: () => registerTransposerTunerComponent({
        system,
        world,
        TRANSPOSER_TUNER_ID,
        handleTransposerTunerUseOn,
        handleTransposerTunerUse,
      }),
    });

    // PHASE 5: Notify
    system.runTimeout(() => {
      try {
        if (DEV_MODE && typeof notifyPlayers === "function") notifyPlayers();
        chat(world, prefix("Â§aâœ“Â§r Systems loaded and ready"));
      } catch {}
    }, 30);
  };

  run().catch((err) => {
    chat(world, prefix("Â§câœ—Â§r startChaos failed during bootstrap imports."));
    chat(world, `Â§c${fmtErr(err)}`);
  });
}
