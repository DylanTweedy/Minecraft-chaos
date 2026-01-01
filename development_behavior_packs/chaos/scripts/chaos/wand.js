// scripts/chaos/wand.js
// Wand interaction handler.
// Pure logic, no imports, everything injected.

export function handleWandUseOn(e, deps) {
  try {
    const {
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
    } = deps;

    const player = e.source;
    if (!player || player.typeId !== "minecraft:player") return;

    const item = e.itemStack;
    if (!item || item.typeId !== WAND_ID) return;

    const block = e.block;
    if (!block) return;

    const typeId = block.typeId;
    const clickedType =
      (typeId === INPUT_ID) ? "input" :
      (typeId === OUTPUT_ID) ? "output" :
      null;

    if (!clickedType) return;

    const pending = getPending(player.id);

    function storePending(type, blk) {
      setPending(player.id, {
        type: type,
        dimId: blk.dimension.id,
        x: blk.location.x,
        y: blk.location.y,
        z: blk.location.z,
        tick: system.currentTick,
      });
    }

    // ---- No pending: select clicked node ----
    if (!pending) {
      storePending(clickedType, block);
      fxSelectInput(player, block, FX);

      player.sendMessage(
        (clickedType === "input")
          ? `§a[Chaos] Input selected: §f${makeKeyFromBlock(block)}§7 (now click an output)`
          : `§d[Chaos] Output selected: §f${makeKeyFromBlock(block)}§7 (now click an input)`
      );
      return;
    }

    // ---- Same type twice: restart selection ----
    if (pending.type === clickedType) {
      storePending(clickedType, block);
      fxSelectInput(player, block, FX);

      player.sendMessage(
        (clickedType === "input")
          ? `§e[Chaos] Input→Input (no pair). Restarted: §f${makeKeyFromBlock(block)}§7 (now click an output)`
          : `§e[Chaos] Output→Output (no pair). Restarted: §f${makeKeyFromBlock(block)}§7 (now click an input)`
      );
      return;
    }

    // ---- Opposite types: toggle link ----
    const inputKey =
      (clickedType === "input") ? makeKeyFromBlock(block) : pendingToKey(pending);

    const outputKey =
      (clickedType === "output") ? makeKeyFromBlock(block) : pendingToKey(pending);

    if (inputKey === outputKey) {
      player.sendMessage("§c[Chaos] Cannot link a node to itself.");
      clearPending(player.id);
      return;
    }

    const result = toggleOutput(inputKey, outputKey);
    const added = !!result.added;
    const removed = !!result.removed;

    if (isPersistenceEnabled()) {
      savePairsToWorldSafe();
    }

    const inputPos =
      (clickedType === "input")
        ? block.location
        : { x: pending.x, y: pending.y, z: pending.z };

    const outputPos =
      (clickedType === "output")
        ? block.location
        : { x: pending.x, y: pending.y, z: pending.z };

    let fxCfg = FX;
    if (removed) {
      fxCfg = Object.assign({}, FX, { _unpair: true });
    }

    fxPairSuccess(player, inputPos, outputPos, fxCfg);

    const map = getPairsMap();
    const perInput = getPerInputOutputCount(map, inputKey);
    const globalLinks = getGlobalLinkCount(map);
    const globalInputs = getGlobalInputCount(map);

    player.sendMessage(
      added
        ? `§b[Chaos] Linked ✓ (§f${perInput}§b outputs for this input | §f${globalLinks}§b links across §f${globalInputs}§b inputs)`
        : removed
        ? `§d[Chaos] Unlinked ✗ (§f${perInput}§d outputs for this input | §f${globalLinks}§d links across §f${globalInputs}§d inputs)`
        : `§7[Chaos] No change (§f${perInput}§7 outputs for this input | §f${globalLinks}§7 links total)`
    );

    clearPending(player.id);
  } catch {
    // absolute safety: wand must never crash
  }
}
