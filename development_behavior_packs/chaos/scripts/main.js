// scripts/main.js
import { world, system } from "@minecraft/server";

import { setPending, getPending } from "./chaos/state.js";
import {
  addOutput,
  getOutputsArray,
  getPairsMap,                 // ✅ for global totals
  loadPairsFromWorldSafe,
  savePairsToWorldSafe,
  isPersistenceEnabled,
} from "./chaos/pairs.js";

import { fxSelectInput, fxPairSuccess } from "./chaos/fx.js";

import {
  SFX_SELECT_INPUT,
  SFX_PAIR_SUCCESS,
  PARTICLE_SELECT_INPUT,
  PARTICLE_PAIR_SUCCESS,
  PARTICLE_BEAM,
} from "./chaos/constants.js";

const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

function makeKey(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

function makeKeyFromBlock(block) {
  const dimId = block.dimension.id;
  const { x, y, z } = block.location;
  return makeKey(dimId, x, y, z);
}

// Central FX config (easy to tweak / debug)
const FX = {
  sfxSelect: SFX_SELECT_INPUT ?? "random.levelup",
  sfxPair: SFX_PAIR_SUCCESS ?? "random.levelup",
  particleSelect: PARTICLE_SELECT_INPUT,
  particleSuccess: PARTICLE_PAIR_SUCCESS,
  particleBeam: PARTICLE_BEAM,
};

// Prevent delayed load from wiping early interactions
let pairsReady = false;

function getGlobalLinkCount() {
  try {
    const map = getPairsMap();
    let total = 0;
    for (const set of map.values()) total += set.size;
    return total;
  } catch {
    return 0;
  }
}

function getGlobalInputCount() {
  try {
    return getPairsMap().size;
  } catch {
    return 0;
  }
}

// ---- Boot: delay DP reads safely ----
system.runTimeout(() => {
  world.sendMessage("§a[Chaos] Script loaded ✅");

  system.runTimeout(() => {
    loadPairsFromWorldSafe();
    pairsReady = true;

    world.sendMessage(
      `§b[Chaos] Pairs loaded. Persistence: ${isPersistenceEnabled() ? "§aON" : "§cOFF"}`
    );

    const inputs = getGlobalInputCount();
    const links = getGlobalLinkCount();
    world.sendMessage(`§7[Chaos] Current links: §f${links}§7 across §f${inputs}§7 inputs`);
  }, 1);
}, 1);

// ---- Component registration ----
system.beforeEvents.startup.subscribe((ev) => {
  ev.itemComponentRegistry.registerCustomComponent("chaos:wand_logic", {
    onUseOn: (e) => {
      const player = e.source;
      if (!player || player.typeId !== "minecraft:player") return;

      const item = e.itemStack;
      if (!item || item.typeId !== WAND_ID) return;

      const block = e.block;
      if (!block) return;

      if (!pairsReady) {
        player.sendMessage("§e[Chaos] Loading links… try again in a moment.");
        return;
      }

      const typeId = block.typeId;

      // ---------- Select input ----------
      if (typeId === INPUT_ID) {
        const key = makeKeyFromBlock(block);

        setPending(player.id, {
          dimId: block.dimension.id,
          x: block.location.x,
          y: block.location.y,
          z: block.location.z,
          tick: system.currentTick,
        });

        fxSelectInput(player, block, FX);
        player.sendMessage(`§a[Chaos] Input selected: §f${key}`);
        return;
      }

      // ---------- Link output ----------
      if (typeId === OUTPUT_ID) {
        const pending = getPending(player.id);
        if (!pending) {
          player.sendMessage("§e[Chaos] No input selected.");
          return;
        }

        const inputKey = makeKey(pending.dimId, pending.x, pending.y, pending.z);
        const outputKey = makeKeyFromBlock(block);

        if (inputKey === outputKey) {
          player.sendMessage("§c[Chaos] Cannot link a node to itself.");
          return;
        }

        const added = addOutput(inputKey, outputKey);
        if (added) savePairsToWorldSafe();

        const outputsNow = getOutputsArray(inputKey);
        const globalLinks = getGlobalLinkCount();
        const globalInputs = getGlobalInputCount();

        fxPairSuccess(
          player,
          { x: pending.x, y: pending.y, z: pending.z },
          block.location,
          FX
        );

        // ✅ Per-input + global totals
        player.sendMessage(
          added
            ? `§b[Chaos] Linked ✓ (§f${outputsNow.length}§b outputs for this input | §f${globalLinks}§b links across §f${globalInputs}§b inputs)`
            : `§7[Chaos] Already linked (§f${outputsNow.length}§7 outputs for this input | §f${globalLinks}§7 links total)`
        );

        return;
      }
    },
  });
});
