import { world, system } from "@minecraft/server";

const WAND_ID = "chaos:wand";
const INPUT_ID = "chaos:input_node";
const OUTPUT_ID = "chaos:output_node";
const TIMEOUT_MS = 60_000;

// player.id -> { key, expiresAt }
const pendingInput = new Map();

// memory-only pairs (for now): inputKey -> outputKey
const pairs = new Map();

function makeKey(block) {
  const dim = block.dimension.id;
  const { x, y, z } = block.location;
  return `${dim}|${x},${y},${z}`;
}

function fmtPos(block) {
  const { x, y, z } = block.location;
  return `(${x},${y},${z})`;
}

function clearPending(p, reason) {
  if (pendingInput.delete(p.id)) {
    p.sendMessage(`§7[Chaos] Pending cleared (${reason})`);
  }
}

function setPending(p, inputBlock) {
  const key = makeKey(inputBlock);
  const expiresAt = Date.now() + TIMEOUT_MS;

  pendingInput.set(p.id, { key, expiresAt });

  p.sendMessage(`§a[Chaos] Input selected… §f${fmtPos(inputBlock)} §8(60s)`);

  // Timeout: only clears if it's still the same pending selection
  system.runTimeout(() => {
    const cur = pendingInput.get(p.id);
    if (!cur) return;
    if (cur.key !== key) return;
    if (Date.now() < cur.expiresAt) return;

    pendingInput.delete(p.id);
    p.sendMessage("§6[Chaos] Pending input timed out (60s)");
  }, Math.ceil(TIMEOUT_MS / 50));
}

function getPending(p) {
  const cur = pendingInput.get(p.id);
  if (!cur) return null;

  if (Date.now() >= cur.expiresAt) {
    pendingInput.delete(p.id);
    p.sendMessage("§6[Chaos] Pending input timed out (60s)");
    return null;
  }

  return cur;
}

system.beforeEvents.startup.subscribe((ev) => {
  const reg = ev.itemComponentRegistry;

  if (!reg || typeof reg.registerCustomComponent !== "function") {
    world.sendMessage("§c[Chaos] itemComponentRegistry missing (enable Custom Components V2 + restart world)");
    return;
  }

  reg.registerCustomComponent("chaos:wand_logic", {
    onUseOn: (e) => {
      const p = e.source;
      if (!p || p.typeId !== "minecraft:player") return;

      const item = e.itemStack;
      if (!item || item.typeId !== WAND_ID) return;

      const b = e.block;
      if (!b) {
        p.sendMessage("§c[Chaos] onUseOn fired but block was null");
        return;
      }

      // Debug every hit
      p.sendMessage(`§7[Chaos] WAND HIT: §f${b.typeId} §8${fmtPos(b)}`);

      // Input selection
      if (b.typeId === INPUT_ID) {
        clearPending(p, "replaced");
        setPending(p, b);
        return;
      }

      // Output selection / pairing
      if (b.typeId === OUTPUT_ID) {
        const pending = getPending(p);

        if (!pending) {
          p.sendMessage("§c[Chaos] No input selected…");
          return;
        }

        const outKey = makeKey(b);

        if (outKey === pending.key) {
          p.sendMessage("§c[Chaos] Cannot pair node to itself");
          return;
        }

        pairs.set(pending.key, outKey);

        p.sendMessage("§b[Chaos] Paired!");
        p.sendMessage(`§7[Chaos] (memory) ${pending.key} -> ${outKey}`);

        clearPending(p, "paired");
        return;
      }

      // Not a node
      p.sendMessage("§8[Chaos] Not a node (ignored)");
    }
  });
});

system.runTimeout(() => {
  world.sendMessage("§a[Chaos] Script loaded ✅ (Phase 1 pairing)");
}, 1);
