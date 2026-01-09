// scripts/chaos/features/magicMirror.js
// Magic Mirror interaction handler.
// Pure logic, no imports, everything injected.

function isAirBlock(block) {
  try {
    if (!block) return false;
    const typeId = block.typeId || "";
    return typeId === "minecraft:air" || typeId === "minecraft:cave_air" || typeId === "minecraft:void_air";
  } catch {
    return false;
  }
}

function isLiquidBlock(block) {
  try {
    if (!block) return false;
    const typeId = block.typeId || "";
    return typeId.includes("water") || typeId.includes("lava");
  } catch {
    return false;
  }
}

function isSolidBlock(block) {
  try {
    if (!block) return false;
    if (isAirBlock(block)) return false;
    if (isLiquidBlock(block)) return false;
    return true;
  } catch {
    return false;
  }
}

function findSafeSpawnHeight(dimension, x, z, startY = 64) {
  try {
    if (!dimension) return startY + 0.5;
    
    const floorX = Math.floor(x);
    const floorZ = Math.floor(z);
    const floorStartY = Math.floor(startY);
    
    // Always search all the way down from startY to find actual ground
    // Don't limit the search distance - scan from startY down to -64 (bedrock level)
    const minY = -64;
    
    for (let y = floorStartY; y >= minY; y--) {
      try {
        const blockLoc = { x: floorX, y: y, z: floorZ };
        const blockAboveLoc = { x: floorX, y: y + 1, z: floorZ };
        
        const block = dimension.getBlock(blockLoc);
        const blockAbove = dimension.getBlock(blockAboveLoc);
        
        if (!block || !blockAbove) continue;
        
        // Found solid ground with air above - spawn on top
        if (!isAirBlock(block) && !isLiquidBlock(block) && isAirBlock(blockAbove)) {
          return y + 1.5; // Stand on top of the block
        }
      } catch {
        continue;
      }
    }
    
    // If no safe ground found all the way down, return startY with small offset (fallback)
    return startY + 0.5;
  } catch {
    return startY + 0.5;
  }
}

function playTeleportSound(entity, location) {
  try {
    if (!entity || !location) return;
    
    // Try multiple sound IDs - ender pearl teleport sounds
    // Based on research: entity.player.teleport (ender pearl teleport), mob.endermen.portal (enderman teleport)
    const dimension = entity.dimension;
    
    // Try dimension.playSound first
    if (dimension && typeof dimension.playSound === "function") {
      try {
        dimension.playSound("mob.endermen.portal", location);
      } catch {
        try {
          dimension.playSound("entity.player.teleport", location);
        } catch {
          try {
            dimension.playSound("random.orb", location);
          } catch {
            // ignore
          }
        }
      }
    }
    
    // Also try player.playSound as backup (for players)
    if (entity.typeId === "minecraft:player" && entity.playSound && typeof entity.playSound === "function") {
      try {
        entity.playSound("mob.endermen.portal", { location });
      } catch {
        try {
          entity.playSound("entity.player.teleport", { location });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

export function teleportToSpawn(entity, deps) {
  try {
    if (!entity || !entity.teleport) return false;

    let spawnLocation = null;
    let spawnDimension = null;
    
    // Try to get player spawn point (bed/respawn anchor/lodestone)
    if (typeof entity.getSpawnPoint === "function") {
      try {
        spawnLocation = entity.getSpawnPoint();
        if (spawnLocation) {
          spawnDimension = entity.dimension;
          
          // Bed/respawn anchor/lodestone spawn location - always find safe ground level
          // getSpawnPoint() returns spawn location - scan down from there to find actual ground
          if (spawnLocation.y >= 32767 || spawnLocation.y < 0) {
            // Invalid Y - find safe height from default
            const safeY = findSafeSpawnHeight(spawnDimension, spawnLocation.x, spawnLocation.z, 64);
            spawnLocation.y = safeY;
          } else {
            // Valid Y from getSpawnPoint - scan all the way down from this Y to find ground
            // This handles cases where bed is high in sky - we'll find the actual ground below
            const spawnY = Math.floor(spawnLocation.y);
            const safeY = findSafeSpawnHeight(spawnDimension, spawnLocation.x, spawnLocation.z, spawnY);
            spawnLocation.y = safeY;
          }
        }
      } catch {
        // ignore
      }
    }
    
    // For non-players, use player's spawn if provided
    if (!spawnLocation && deps?.playerSpawnLocation) {
      spawnLocation = { 
        x: deps.playerSpawnLocation.x, 
        y: deps.playerSpawnLocation.y, 
        z: deps.playerSpawnLocation.z 
      };
      spawnDimension = deps.world?.getDimension("minecraft:overworld");
      if (spawnLocation && spawnDimension) {
        const safeY = findSafeSpawnHeight(spawnDimension, spawnLocation.x, spawnLocation.z, Math.floor(spawnLocation.y || 64));
        spawnLocation.y = safeY;
      }
    }

    // Fallback to world spawn if no bed/respawn anchor/lodestone
    if (!spawnLocation) {
      try {
        const world = deps?.world || (entity.dimension?.world);
        if (world && typeof world.getDefaultSpawnLocation === "function") {
          // Get world's default spawn location
          const defaultSpawn = world.getDefaultSpawnLocation();
          spawnDimension = world.getDimension("minecraft:overworld");
          
          // Fix Y coordinate if it's the invalid 32767 value or negative
          if (defaultSpawn && spawnDimension) {
            let startY = defaultSpawn.y;
            if (startY >= 32767 || startY < 0) {
              startY = 64; // Default height
            }
            
            // Find safe ground level
            const safeY = findSafeSpawnHeight(spawnDimension, defaultSpawn.x, defaultSpawn.z, Math.floor(startY));
            spawnLocation = {
              x: defaultSpawn.x,
              y: safeY,
              z: defaultSpawn.z
            };
          }
        }
      } catch {
        // ignore
      }
    }

    if (!spawnLocation) {
      if (entity.sendMessage) {
        entity.sendMessage("§c[Chaos] No spawn point available.");
      }
      return false;
    }

    // Play teleport sound at origin location
    const originLoc = entity.location;
    if (originLoc) {
      playTeleportSound(entity, originLoc);
    }

    // Teleport to spawn location (in correct dimension if different)
    entity.teleport(spawnLocation, {
      dimension: spawnDimension || entity.dimension,
      keepVelocity: false,
    });

    // Play teleport sound at destination location
    playTeleportSound(entity, spawnLocation);

    return true;
  } catch {
    return false;
  }
}

export function teleportUpward(player, deps) {
  try {
    if (!player || !player.teleport) return false;

    const dimension = player.dimension;
    if (!dimension) return false;

    const startLoc = player.location;
    if (!startLoc) return false;

    const maxSearch = 64;
    const startY = Math.floor(startLoc.y);
    const x = Math.floor(startLoc.x);
    const z = Math.floor(startLoc.z);

    for (let y = startY + 1; y <= startY + maxSearch; y++) {
      try {
        const blockBelowLoc = { x, y, z };
        const blockAboveLoc = { x, y: y + 1, z };

        const blockBelow = dimension.getBlock(blockBelowLoc);
        const blockAbove = dimension.getBlock(blockAboveLoc);

        if (blockBelow && blockAbove) {
          if (
            isSolidBlock(blockBelow) &&
            !isLiquidBlock(blockBelow) &&
            isAirBlock(blockAbove)
          ) {
            const teleportLoc = {
              x: x + 0.5,
              y: y + 1,
              z: z + 0.5,
            };

            // Play teleport sound at origin location
            playTeleportSound(player, startLoc);

            player.teleport(teleportLoc, {
              keepVelocity: false,
            });

            // Play teleport sound at destination location
            playTeleportSound(player, teleportLoc);

            return true;
          }
        }
      } catch {
        continue;
      }
    }

    if (player.sendMessage) {
      player.sendMessage("§c[Chaos] No safe location above.");
    }
    return false;
  } catch {
    return false;
  }
}

export function handleMirrorUse(e, deps) {
  try {
    const { MIRROR_ID, world } = deps;

    const player = e.source || e.player;
    if (!player || player.typeId !== "minecraft:player") return;

    const item = e.itemStack;
    if (!item) return;

    const itemId = item.typeId;
    if (itemId !== MIRROR_ID) return;

    // Check if crouching
    if (player.isSneaking) {
      teleportUpward(player, deps);
    } else {
      teleportToSpawn(player, deps);
    }
  } catch {
    // ignore
  }
}

export function handleMirrorUseOn(e, deps) {
  try {
    handleMirrorUse(e, deps);
  } catch {
    // ignore
  }
}

export function handleMirrorEntityAttack(e, deps) {
  try {
    const { MIRROR_ID, world } = deps;

    const player = e.player;
    if (!player || player.typeId !== "minecraft:player") return;

    const attackedEntity = e.attackedEntity;
    if (!attackedEntity) return;

    const inventory = player.getComponent?.("minecraft:inventory");
    const container = inventory?.container;
    if (!container) return;

    const selectedSlot = player.selectedSlotIndex || 0;
    const itemStack = container.getItem(selectedSlot);
    if (!itemStack) return;

    const itemId = itemStack.typeId;
    if (itemId !== MIRROR_ID) return;

    // Teleport attacked entity to player's spawn point (with world spawn fallback)
    const playerSpawn = player.getSpawnPoint?.();
    teleportToSpawn(attackedEntity, { ...deps, playerSpawnLocation: playerSpawn, world });
  } catch {
    // ignore
  }
}
