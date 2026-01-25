// scripts/chaos/features/teleporter/linking.js
import { fxPairSuccess, fxSelectInput } from "../../fx/fx.js";
import { FX } from "../../fx/fxConfig.js";
import { key as makeKey, parseKey } from "../logistics/keys.js";
import { getLinkedKey, linkKeys, unlinkKey } from "./pairs.js";
import { system } from "@minecraft/server";

const TELEPORTER_ID = "chaos:teleporter";
const selectionByPlayer = new Map(); // playerId -> teleporterKey
const lastUseTickByPlayer = new Map(); // playerId -> tick

function getTeleporterKey(block) {
  try {
    if (!block || block.typeId !== TELEPORTER_ID) return null;
    const dimId = block.dimension?.id;
    const loc = block.location;
    if (!dimId || !loc) return null;
    return makeKey(dimId, loc.x, loc.y, loc.z);
  } catch {
    return null;
  }
}

function msg(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // ignore
  }
}

function resolveBlockFromEvent(e) {
  const block = e?.block;
  if (block) return block;
  const dim = e?.source?.dimension || e?.player?.dimension;
  const loc = e?.blockLocation;
  if (!dim || !loc) return null;
  try {
    return dim.getBlock(loc);
  } catch {
    return null;
  }
}

function resolveBlockFromView(player) {
  try {
    const hit = player?.getBlockFromViewDirection?.({ maxDistance: 6 });
    return hit?.block || null;
  } catch {
    return null;
  }
}

function playLinkFx(player, aKey, bKey, isUnpair) {
  try {
    const a = parseKey(aKey);
    const b = parseKey(bKey);
    if (!a || !b) return;
    const fx = { ...FX, _unpair: !!isUnpair };
    fxPairSuccess(player, a, b, fx);
  } catch {
    // ignore
  }
}

function handleLinkWithBlock(player, block) {
  if (!player || !block) return;
  const tick = system.currentTick ?? 0;
  const last = lastUseTickByPlayer.get(player.id) | 0;
  if (last === tick) return;
  lastUseTickByPlayer.set(player.id, tick);
  if (block.typeId !== TELEPORTER_ID) {
    msg(player, "Not a teleporter.");
    return;
  }

  const key = getTeleporterKey(block);
  if (!key) {
    msg(player, "Teleporter invalid.");
    return;
  }

  const isSneaking = !!player.isSneaking;
  if (isSneaking) {
    const linked = getLinkedKey(key);
    if (linked) {
      unlinkKey(key);
      playLinkFx(player, key, linked, true);
      msg(player, "Teleporter unlinked.");
    } else {
      msg(player, "Teleporter is not linked.");
    }
    selectionByPlayer.delete(player.id);
    return;
  }

  const selected = selectionByPlayer.get(player.id);
  if (!selected) {
    selectionByPlayer.set(player.id, key);
    fxSelectInput(player, block, FX);
    msg(player, "Teleporter selected.");
    return;
  }

  if (selected === key) {
    selectionByPlayer.delete(player.id);
    msg(player, "Selection cleared.");
    return;
  }

  const linked = getLinkedKey(selected);
  if (linked === key) {
    unlinkKey(selected);
    playLinkFx(player, selected, key, true);
    msg(player, "Teleporters unlinked.");
    selectionByPlayer.delete(player.id);
    return;
  }

  linkKeys(selected, key);
  playLinkFx(player, selected, key, false);
  msg(player, "Teleporters linked.");
  selectionByPlayer.delete(player.id);
}

export function handleTeleporterTunerUseOn(e) {
  try {
    const player = e?.source || e?.player;
    const block = resolveBlockFromEvent(e) || resolveBlockFromView(player);
    if (!player || !block) return;
    handleLinkWithBlock(player, block);
  } catch {
    // ignore
  }
}

export function handleTeleporterTunerUse(e) {
  try {
    const player = e?.source || e?.player;
    if (!player) return;
    const block = resolveBlockFromView(player);
    if (!block) {
      msg(player, "Aim at a teleporter.");
      return;
    }
    handleLinkWithBlock(player, block);
  } catch {
    // ignore
  }
}
