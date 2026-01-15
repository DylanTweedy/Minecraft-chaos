// scripts/chaos/wandBeam.js
import { world, system } from "@minecraft/server";
import { spawnTestBeam } from "./beamMove.js";

const WAND_ID = "chaos:wand";

// LOCKED ID. If chat shows anything else, you're not running this file.
const BEAM_ID = "chaos:beam_entity";

world.afterEvents.itemUse.subscribe((ev) => {
  const player = ev.source;
  const item = ev.itemStack;
  if (!player || player.typeId !== "minecraft:player") return;
  if (!item || item.typeId !== WAND_ID) return;
  
  player.sendMessage(`[Chaos] WandBeam v7 (spawning ${BEAM_ID})`);

  const hit = player.getBlockFromViewDirection?.({ maxDistance: 64 });
  if (!hit?.block) {
    player.sendMessage("[Chaos] No block hit.");
    return;
  }

  const startBlock = hit.block.location;

  // End point is along view direction
  const dir = player.getViewDirection();
  const endBlock = {
    x: startBlock.x + Math.round(dir.x * 10),
    y: startBlock.y + Math.round(dir.y * 10),
    z: startBlock.z + Math.round(dir.z * 10),
  };

  player.sendMessage(
    `[Chaos] Beam test: start=${startBlock.x},${startBlock.y},${startBlock.z} end=${endBlock.x},${endBlock.y},${endBlock.z}`
  );

  spawnTestBeam(player, {
    beamId: BEAM_ID,
    startBlock,
    endBlock,
    alpha: 1.0,
    spinDegPerTick: 20,
    speedBlocksPerTick: 3,
  });
});
