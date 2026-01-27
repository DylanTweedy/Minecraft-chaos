// scripts/main.js
import { world, system } from "@minecraft/server";

const BOOTSTRAP_PATH = "./chaos/bootstrap/index.js";

// Guard against accidental double-start inside the same script context.
let __booted = false;

// Chat-only logging helpers (since we have no console output)
function chat(line) {
  try {
    world.sendMessage(line);
  } catch {
    // If chat fails, we can't report anything anyway.
  }
}

function prefix(tag, msg) {
  return `§8[§dChaos§8]§r ${tag} ${msg}`;
}

// Keep stacks readable and not insanely long in chat
function formatError(e, maxChars = 800) {
  const msg = e?.message ? String(e.message) : String(e);
  const stack = e?.stack ? String(e.stack) : "";
  if (!stack) return msg;

  const trimmed = stack.length > maxChars ? stack.slice(0, maxChars) + "…" : stack;
  return `${msg}\n§7${trimmed}§r`;
}

function extractImportDetails(e) {
  const msg = e?.message ? String(e.message) : String(e);
  let missing = null;
  let match = msg.match(/Import\s+\[(.+?)\]\s+not found/i);
  if (!match) match = msg.match(/Cannot find module\s+['\"](.+?)['\"]/i);
  if (match) missing = match[1];

  const stack = e?.stack ? String(e.stack) : "";
  let origin = null;
  if (stack) {
    const lines = stack.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line === msg) continue;
      if (line.startsWith("at ")) {
        origin = line.slice(3);
        break;
      }
      if (line.startsWith("@")) {
        origin = line.slice(1);
        break;
      }
      if (line.includes(".js")) {
        origin = line;
        break;
      }
    }
  }

  return { missing, origin };
}
system.runTimeout(() => {
  if (__booted) return;
  __booted = true;

  chat(prefix("§a✓§r", "Main loaded. Importing bootstrap…"));

  import(BOOTSTRAP_PATH)
    .then((module) => {
      chat(prefix("§a✓§r", `Imported ${BOOTSTRAP_PATH}`));

      const startChaos = module?.startChaos;
      if (typeof startChaos !== "function") {
        chat(prefix("§c✗§r", "bootstrap exported no startChaos() function."));
        chat(prefix("§e?§r", "Expected: export function startChaos(ctx) { ... }"));
        return;
      }

      try {
        startChaos({ world, system });
        chat(prefix("§a✓§r", "startChaos() called successfully."));
      } catch (e) {
        chat(prefix("§c✗§r", "startChaos() threw an error:"));
        chat("§c" + formatError(e));
      const details = extractImportDetails(e);
      if (details.missing) {
        chat(prefix("§eWhere§r", `Missing module: ${details.missing}`));
      }
      if (details.origin) {
        chat(prefix("§eFrom§r", `Import trace: ${details.origin}`));
      }
      }
    })
    .catch((e) => {
      chat(prefix("§c✗§r", `Bootstrap import FAILED: ${BOOTSTRAP_PATH}`));
      chat("§c" + formatError(e));
      chat(prefix("§eHint§r", "This almost always means a broken static import somewhere under bootstrap."));
      chat(prefix("§eHint§r", "Check: wrong path, missing file, circular import, or export typo."));
    });
}, 1);

