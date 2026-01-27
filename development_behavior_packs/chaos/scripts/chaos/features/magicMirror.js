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

    const minY = -64;

    for (let y = floorStartY; y >= minY; y--) {
      try {
        const blockLoc = { x: floorX, y: y, z: floorZ };
        const blockAboveLoc = { x: floorX, y: y + 1, z: floorZ };

        const block = dimension.getBlock(blockLoc);
        const blockAbove = dimension.getBlock(blockAboveLoc);

        if (!block || !blockAbove) continue;

        if (!isAirBlock(block) && !isLiquidBlock(block) && isAirBlock(blockAbove)) {
          return y + 1.5;
        }
      } catch {
        continue;
      }
    }

    return startY + 0.5;
  } catch {
    return startY + 0.5;
  }
}

function tryPlaySoundAt(dimension, entity, soundId, location) {
  try {
    if (dimension && typeof dimension.playSound === "function") {
      try {
        dimension.playSound(soundId, location);
        return true;
      } catch {
        // ignore
      }
    }

    // Older/alternate signature: entity.playSound(sound, { location })
    if (entity?.typeId === "minecraft:player" && entity.playSound && typeof entity.playSound === "function") {
      try {
        entity.playSound(soundId, { location });
        return true;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return false;
}

// Player-local sound: ALWAYS heard by that player, regardless of distance.
// Use this for "arrival" so you always hear the teleport even if world spawn is far away.
function tryPlaySoundToPlayer(player, soundId, volume = 1, pitch = 1) {
  try {
    if (!player || player.typeId !== "minecraft:player") return false;
    if (typeof player.playSound !== "function") return false;
    player.playSound(soundId, { volume, pitch });
    return true;
  } catch {
    return false;
  }
}

function playTeleportStartSound(entity, location) {
  try {
    if (!entity || !location) return;
    const dimension = entity.dimension;

    // "cast/launch" vibe first, then fall back to teleport-ish sounds
    const candidates = [
      "entity.ender_pearl.throw",
      "random.orb",
      "entity.player.teleport",
      "mob.endermen.portal",
    ];

    for (const id of candidates) {
      if (tryPlaySoundAt(dimension, entity, id, location)) return;
    }
  } catch {
    // ignore
  }
}

function playTeleportEndSound(entity, location) {
  try {
    if (!entity || !location) return;
    const dimension = entity.dimension;

    const candidates = ["mob.endermen.portal", "entity.player.teleport", "random.orb"];

    // Prefer player-local sound so the transposer ALWAYS hears it
    if (entity.typeId === "minecraft:player") {
      for (const id of candidates) {
        if (tryPlaySoundToPlayer(entity, id, 1, 1)) return;
      }
    }

    // Also play positional sound at the destination for nearby players (nice multiplayer vibe)
    for (const id of candidates) {
      if (tryPlaySoundAt(dimension, entity, id, location)) return;
    }
  } catch {
    // ignore
  }
}

function playTeleportParticlesAtDim(dim, location) {
  try {
    if (!dim || typeof dim.spawnParticle !== "function") return;

    // Some vanilla particles are flaky; these tend to be reliable.
    const candidates = [
      "minecraft:basic_smoke_particle",
      "minecraft:enchanting_table_particle",
      "minecraft:totem_particle",
      // Bonus: looks great when it works, harmless when it doesn't
      "minecraft:portal",
    ];

    for (const id of candidates) {
      try {
        dim.spawnParticle(id, location);
      } catch {
        // ignore missing/broken particle IDs
      }
    }
  } catch {
    // ignore
  }
}

function playTeleportParticles(entity, location) {
  try {
    if (!entity || !location) return;
    const dim = entity.dimension;
    playTeleportParticlesAtDim(dim, location);
  } catch {
    // ignore
  }
}

function playTeleportFXStart(entity, location) {
  playTeleportStartSound(entity, location);
  playTeleportParticles(entity, location);
}

function playTeleportFXEnd(entity, location) {
  playTeleportEndSound(entity, location);
  playTeleportParticles(entity, location);
}

// Important: after teleport(), run "arrival" FX on next tick using the entity's real location + dimension.
// This avoids the one-tick desync where FX can fire in the wrong dim or before the client is ready.
function scheduleArrivalFX(entity, deps, fallbackLoc) {
  try {
    const system = deps?.system;
    if (system && typeof system.runTimeout === "function") {
      system.runTimeout(() => {
        try {
          const dim = entity?.dimension;
          const loc = entity?.location || fallbackLoc;
          if (!dim || !loc) return;

          // sound + particles at the *actual* post-teleport position
          playTeleportEndSound(entity, loc);
          playTeleportParticlesAtDim(dim, loc);

          // optional: second shimmer pulse (feels more "mirror")
          system.runTimeout(() => {
            try {
              const dim2 = entity?.dimension;
              const loc2 = entity?.location || loc;
              if (!dim2 || !loc2) return;
              playTeleportParticlesAtDim(dim2, loc2);
            } catch {}
          }, 2);
        } catch {
          // ignore
        }
      }, 1);
      return true;
    }

    // Fallback: immediate (less reliable, but better than nothing)
    if (fallbackLoc) playTeleportFXEnd(entity, fallbackLoc);
    return false;
  } catch {
    if (fallbackLoc) playTeleportFXEnd(entity, fallbackLoc);
    return false;
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

          if (spawnLocation.y >= 32767 || spawnLocation.y < 0) {
            const safeY = findSafeSpawnHeight(spawnDimension, spawnLocation.x, spawnLocation.z, 64);
            spawnLocation.y = safeY;
          } else {
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
        z: deps.playerSpawnLocation.z,
      };
      spawnDimension = deps.world?.getDimension("minecraft:overworld");
      if (spawnLocation && spawnDimension) {
        const safeY = findSafeSpawnHeight(
          spawnDimension,
          spawnLocation.x,
          spawnLocation.z,
          Math.floor(spawnLocation.y || 64)
        );
        spawnLocation.y = safeY;
      }
    }

    // Fallback to world spawn if no bed/respawn anchor/lodestone
    if (!spawnLocation) {
      try {
        const world = deps?.world || (entity.dimension?.world);
        if (world && typeof world.getDefaultSpawnLocation === "function") {
          const defaultSpawn = world.getDefaultSpawnLocation();
          spawnDimension = world.getDimension("minecraft:overworld");

          if (defaultSpawn && spawnDimension) {
            let startY = defaultSpawn.y;
            if (startY >= 32767 || startY < 0) startY = 64;

            const safeY = findSafeSpawnHeight(spawnDimension, defaultSpawn.x, defaultSpawn.z, Math.floor(startY));
            spawnLocation = {
              x: defaultSpawn.x,
              y: safeY,
              z: defaultSpawn.z,
            };
          }
        }
      } catch {
        // ignore
      }
    }

    if (!spawnLocation) {
      if (entity.sendMessage) entity.sendMessage("§c[Chaos] No spawn point available.");
      return false;
    }

    // FX at origin (positional is fine here — you're definitely nearby)
    const originLoc = entity.location;
    if (originLoc) playTeleportFXStart(entity, originLoc);

    // Teleport
    entity.teleport(spawnLocation, {
      dimension: spawnDimension || entity.dimension,
      keepVelocity: false,
    });

    // Arrival FX on next tick at actual location/dimension
    scheduleArrivalFX(entity, deps, spawnLocation);

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
          if (isSolidBlock(blockBelow) && !isLiquidBlock(blockBelow) && isAirBlock(blockAbove)) {
            const teleportLoc = {
              x: x + 0.5,
              y: y + 1,
              z: z + 0.5,
            };

            playTeleportFXStart(player, startLoc);

            player.teleport(teleportLoc, { keepVelocity: false });

            scheduleArrivalFX(player, deps, teleportLoc);

            return true;
          }
        }
      } catch {
        continue;
      }
    }

    if (player.sendMessage) player.sendMessage("§c[Chaos] No safe location above.");
    return false;
  } catch {
    return false;
  }
}

export function handleMirrorUse(e, deps) {
  try {
    const { MIRROR_ID } = deps;

    const player = e.source || e.player;
    if (!player || player.typeId !== "minecraft:player") return;

    const item = e.itemStack;
    if (!item) return;

    const itemId = item.typeId;
    if (itemId !== MIRROR_ID) return;

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
