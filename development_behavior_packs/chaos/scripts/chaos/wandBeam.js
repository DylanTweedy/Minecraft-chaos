// scripts/chaos/wandBeam.js
import { world } from "@minecraft/server";
import { startBeamBetween } from "./beamMover.js";

const WAND_ID = "chaos:wand";

const DIST = 8;     // blocks away for testing
const SPEED = 1;    // blocks per tick

const CARDINAL = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

world.afterEvents.itemUse.subscribe((ev) => {
  const player = ev.source;
  const item = ev.itemStack;
  if (!player || player.typeId !== "minecraft:player") return;
  if (!item || item.typeId !== WAND_ID) return;

  const hit = player.getBlockFromViewDirection?.({ maxDistance: 64 });
  if (!hit || !hit.block) {
    player.sendMessage("No block hit.");
    return;
  }

  const startBlock = hit.block.location;

  const d = CARDINAL[Math.floor(Math.random() * CARDINAL.length)];
  const endBlock = {
    x: startBlock.x + d.x * DIST,
    y: startBlock.y + d.y * DIST,
    z: startBlock.z + d.z * DIST,
  };

  player.sendMessage(
    `Beam start=${startBlock.x},${startBlock.y},${startBlock.z} dir=(${d.x},${d.y},${d.z}) end=${endBlock.x},${endBlock.y},${endBlock.z}`
  );

  const beam = startBeamBetween(player.dimension, {
    startBlock,
    endBlock,
    speedBlocksPerTick: SPEED,
  });

  if (!beam) {
    player.sendMessage("Beam spawn failed.");
  }
});
