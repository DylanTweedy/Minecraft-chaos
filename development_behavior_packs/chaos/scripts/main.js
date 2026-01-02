// scripts/main.js
import { world, system, MolangVariableMap } from "@minecraft/server";

import { setPending, getPending, clearPending } from "./chaos/state.js";
import {
  toggleOutput,
  getPairsMap,
  loadPairsFromWorldSafe,
  savePairsToWorldSafe,
  isPersistenceEnabled,
} from "./chaos/pairs.js";

import { fxSelectInput, fxPairSuccess, fxTransferItem } from "./chaos/fx.js";

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
import { createTransferController } from "./chaos/transfer.js";

import { startLinkVision } from "./chaos/linkVision.js";
startLinkVision();

import { startCleanupOnBreak } from "./chaos/cleanupOnBreak.js";
startCleanupOnBreak();


const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";

// Must match transfer_orb.json lifetime (seconds)
const ORB_LIFETIME_SECONDS = 1.0;

// Cosmetic clamps so it doesn’t look absurd for long/short links
const ORB_SPEED_MIN = 0.6;
const ORB_SPEED_MAX = 12.0;

const FX = {
  sfxSelect: (SFX_SELECT_INPUT != null ? SFX_SELECT_INPUT : "random.levelup"),
  sfxPair: (SFX_PAIR_SUCCESS != null ? SFX_PAIR_SUCCESS : "random.levelup"),
  sfxUnpair: (SFX_UNPAIR != null ? SFX_UNPAIR : "random.anvil_land"),

  particleSelect: PARTICLE_SELECT_INPUT,
  particleSuccess: PARTICLE_PAIR_SUCCESS,
  particleBeam: PARTICLE_BEAM,

  particleUnpair: PARTICLE_UNPAIR_SUCCESS,
  particleBeamUnpair: PARTICLE_UNPAIR_BEAM,

  particleTransferBeam: "chaos:transfer_beam",
  particleTransferItem: "chaos:transfer_orb",

  // Signature supports extra args (fx.js will pass them):
  // makeMolang(dir, fromBlock, toBlock, itemTypeId)
  makeMolang: (dir, fromBlock, toBlock /*, itemTypeId */) => {
    try {
      if (!dir || !fromBlock || !toBlock) return null;

      const dx = Number(dir.x);
      const dy = Number(dir.y);
      const dz = Number(dir.z);
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;

      // Compute distance between the same spawn points fx.js uses:
      const ax = fromBlock.location.x + 0.5;
      const ay = fromBlock.location.y + 1.05;
      const az = fromBlock.location.z + 0.5;

      const bx = toBlock.location.x + 0.5;
      const by = toBlock.location.y + 1.05;
      const bz = toBlock.location.z + 0.5;

      const ddx = bx - ax;
      const ddy = by - ay;
      const ddz = bz - az;

      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (!Number.isFinite(dist) || dist <= 0.0001) return null;

      // speed = distance / lifetime (blocks per second)
      let speed = dist / ORB_LIFETIME_SECONDS;

      // Clamp to keep visuals sane
      if (speed < ORB_SPEED_MIN) speed = ORB_SPEED_MIN;
      if (speed > ORB_SPEED_MAX) speed = ORB_SPEED_MAX;

      const m = new MolangVariableMap();
      m.setSpeedAndDirection("variable.chaos_move", speed, { x: dx, y: dy, z: dz });
      return m;
    } catch {
      return null;
    }
  },
};

let pairsReady = false;
let transferStarted = false;

function parseKey(key) {
  try {
    if (typeof key !== "string") return null;
    const pipe = key.indexOf("|");
    if (pipe <= 0) return null;

    const dimId = key.slice(0, pipe);
    const rest = key.slice(pipe + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;

    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

    return { dimId, x: x | 0, y: y | 0, z: z | 0 };
  } catch {
    return null;
  }
}

// Boot (DP load delayed inside bootstrap)
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

// Start transfer loop after ready
system.runInterval(() => {
  if (transferStarted) return;
  if (!pairsReady) return;

  transferStarted = true;

  try {
    const controller = createTransferController(
      {
        world,
        system,
        isPairsReady: () => pairsReady,
        getPairsMap,
        parseKey,
        fxTransfer: (fromBlock, toBlock, itemTypeId) =>
          fxTransferItem(fromBlock, toBlock, itemTypeId, FX),
      },
      {
        maxTransfersPerTick: 4,
        perInputIntervalTicks: 10,
        maxAltOutputTries: 2,
      }
    );
    controller.start();
  } catch {
    // never break load
  }
}, 1);

// Component registration
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
        WAND_ID,
        INPUT_ID,
        OUTPUT_ID,

        getPending,
        setPending,
        clearPending,

        toggleOutput,
        savePairsToWorldSafe,
        isPersistenceEnabled,
        getPairsMap,

        getGlobalInputCount,
        getGlobalLinkCount,
        getPerInputOutputCount,

        makeKeyFromBlock,
        pendingToKey,

        fxSelectInput,
        fxPairSuccess,
        FX,

        system,
      });
    },
  });
});
