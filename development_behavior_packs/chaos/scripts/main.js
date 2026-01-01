// scripts/main.js
import { world, system } from "@minecraft/server";

import { setPending, getPending, clearPending } from "./chaos/state.js";
import {
  toggleOutput,
  getPairsMap,
  loadPairsFromWorldSafe,
  savePairsToWorldSafe,
  isPersistenceEnabled,
} from "./chaos/pairs.js";

import { fxSelectInput, fxPairSuccess } from "./chaos/fx.js";

import {
  getGlobalInputCount,
  getGlobalLinkCount,
  getPerInputOutputCount,
} from "./chaos/stats.js";

import {
  SFX_SELECT_INPUT,
  SFX_PAIR_SUCCESS,
  SFX_UNPAIR,
  PARTICLE_SELECT_INPUT,
  PARTICLE_PAIR_SUCCESS,
  PARTICLE_BEAM,
  PARTICLE_UNPAIR_SUCCESS,
  PARTICLE_UNPAIR_BEAM,
} from "./chaos/constants.js";

import { makeKeyFromBlock, pendingToKey } from "./chaos/keys.js";
import { handleWandUseOn } from "./chaos/wand.js";
import { bootChaos } from "./chaos/bootstrap.js";

const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

// Central FX config (easy to tweak / debug)
const FX = {
  sfxSelect: (SFX_SELECT_INPUT != null ? SFX_SELECT_INPUT : "random.levelup"),
  sfxPair: (SFX_PAIR_SUCCESS != null ? SFX_PAIR_SUCCESS : "random.levelup"),
  sfxUnpair: (SFX_UNPAIR != null ? SFX_UNPAIR : "random.anvil_land"),

  particleSelect: PARTICLE_SELECT_INPUT,
  particleSuccess: PARTICLE_PAIR_SUCCESS,
  particleBeam: PARTICLE_BEAM,

  // NEW: unpair visuals (fx.js falls back safely if undefined)
  particleUnpair: PARTICLE_UNPAIR_SUCCESS,
  particleBeamUnpair: PARTICLE_UNPAIR_BEAM,
};

let pairsReady = false;

// ---- Boot (DP load is delayed inside bootstrap) ----
bootChaos({
  world,
  system,
  loadPairsFromWorldSafe,
  isPersistenceEnabled,
  getPairsMap,
  getGlobalInputCount,
  getGlobalLinkCount,
  onReady: () => { pairsReady = true; },
});

// ---- Component registration ----
system.beforeEvents.startup.subscribe((ev) => {
  ev.itemComponentRegistry.registerCustomComponent("chaos:wand_logic", {
    onUseOn: (e) => {
      const player = e.source;
      if (!player || player.typeId !== "minecraft:player") return;

      if (!pairsReady) {
        player.sendMessage("§e[Chaos] Loading links… try again in a moment.");
        return;
      }

      handleWandUseOn(e, {
        // ids
        WAND_ID,
        INPUT_ID,
        OUTPUT_ID,

        // state
        getPending,
        setPending,
        clearPending,

        // pairs / persistence
        toggleOutput,
        savePairsToWorldSafe,
        isPersistenceEnabled,
        getPairsMap,

        // stats
        getGlobalInputCount,
        getGlobalLinkCount,
        getPerInputOutputCount,

        // keys
        makeKeyFromBlock,
        pendingToKey,

        // fx
        fxSelectInput,
        fxPairSuccess,
        FX,

        // runtime
        system,
      });
    },
  });
});
