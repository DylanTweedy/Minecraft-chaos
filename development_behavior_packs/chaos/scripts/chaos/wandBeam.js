// scripts/chaos/wandBeam.js
import { world } from "@minecraft/server";
import { spawnTestBeam } from "./beamMove.js";

const WAND_ID = "chaos:wand";

// New beam IDs (must exist in BP/RP)
const BEAM_H = "chaos:beam_h";
const BEAM_V = "chaos:beam_v";

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomCardinalDir() {
  // 6 directions: ±X, ±Y, ±Z
  const dirs = [
    { x:  1, y:  0, z:  0 },
    { x: -1, y:  0, z:  0 },
    { x:  0, y:  1, z:  0 },
    { x:  0, y: -1, z:  0 },
    { x:  0, y:  0, z:  1 },
    { x:  0, y:  0, z: -1 },
  ];
  return dirs[randInt(0, dirs.length - 1)];
}

world.afterEvents.itemUse.subscribe((ev) => {
  const player = ev.source;
  const item = ev.itemStack;

  if (!player || player.typeId !== "minecraft:player") return;
  if (!item || item.typeId !== WAND_ID) return;

  const hit = player.getBlockFromViewDirection?.({ maxDistance: 64 });
  if (!hit?.block) {
    player.sendMessage("[Chaos] No block hit.");
    return;
  }

  const startBlock = hit.block.location;

  const dir = pickRandomCardinalDir();
  const length = randInt(4, 20);

  const endBlock = {
    x: startBlock.x + dir.x * length,
    y: startBlock.y + dir.y * length,
    z: startBlock.z + dir.z * length,
  };

  const beamId = (dir.y !== 0) ? BEAM_V : BEAM_H;

  player.sendMessage(
    `[Chaos] Beam: ${beamId} dir=(${dir.x},${dir.y},${dir.z}) len=${length} start=${startBlock.x},${startBlock.y},${startBlock.z}`
  );

  spawnTestBeam(player, {
    beamId,
    startBlock,
    endBlock,
    alpha: 1.0,
    spinDegPerTick: 20,
    speedBlocksPerTick: 3,
    lifeTicks: 120,
  });
});
