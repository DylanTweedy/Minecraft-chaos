// scripts/chaos/features/transposer/linking.js
import { fxPairSuccess, fxSelectInput } from "../../fx/fx.js";
import { FX } from "../../fx/fxConfig.js";
import { key as makeKey, parseKey } from "../logistics/keys.js";
import { getLinkedKey, linkKeys, unlinkKey } from "./pairs.js";
import { system, world } from "@minecraft/server";
import { mergeStatesOnLink, splitStateOnUnlink } from "./state.js";

const TRANSPOSER_ID = "chaos:teleporter";
const TRANSPOSER_STATE_KEY = "chaos:transposer_state";
const STATE_UNLINKED = 0;
const STATE_LINKED_UNPOWERED = 1;
const selectionByPlayer = new Map(); // playerId -> transposerKey
const lastUseTickByPlayer = new Map(); // playerId -> tick

function getTransposerKey(block) {
  try {
    if (!block || block.typeId !== TRANSPOSER_ID) return null;
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

function setTransposerState(block, state) {
  try {
    const perm = block?.permutation;
    if (!perm) return;
    const cur = perm.getState(TRANSPOSER_STATE_KEY);
    if (cur === state) return;
    block.setPermutation(perm.withState(TRANSPOSER_STATE_KEY, state));
  } catch {
    // ignore
  }
}

function setStateForKey(key, state) {
  try {
    const parsed = parseKey(key);
    if (!parsed) return;
    const dim = world.getDimension(parsed.dimId);
    const block = dim?.getBlock?.({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!block || block.typeId !== TRANSPOSER_ID) return;
    setTransposerState(block, state);
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
  if (block.typeId !== TRANSPOSER_ID) {
    msg(player, "Not a transposer.");
    return;
  }

  const key = getTransposerKey(block);
  if (!key) {
    msg(player, "Transposer invalid.");
    return;
  }

  const isSneaking = !!player.isSneaking;
  if (isSneaking) {
    const linked = getLinkedKey(key);
    if (linked) {
      unlinkKey(key);
      splitStateOnUnlink(key, linked);
      playLinkFx(player, key, linked, true);
      setTransposerState(block, STATE_UNLINKED);
      setStateForKey(linked, STATE_UNLINKED);
      msg(player, "Transposer unlinked.");
    } else {
      msg(player, "Transposer is not linked.");
    }
    selectionByPlayer.delete(player.id);
    return;
  }

  const selected = selectionByPlayer.get(player.id);
  if (!selected) {
    selectionByPlayer.set(player.id, key);
    fxSelectInput(player, block, FX);
    msg(player, "Transposer selected.");
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
    splitStateOnUnlink(selected, key);
    playLinkFx(player, selected, key, true);
    setStateForKey(selected, STATE_UNLINKED);
    setStateForKey(key, STATE_UNLINKED);
    msg(player, "Transposers unlinked.");
    selectionByPlayer.delete(player.id);
    return;
  }

  const selectedLinked = getLinkedKey(selected);
  if (selectedLinked && selectedLinked !== key) {
    unlinkKey(selected);
    splitStateOnUnlink(selected, selectedLinked);
  }

  const keyLinked = getLinkedKey(key);
  if (keyLinked && keyLinked !== selected) {
    unlinkKey(key);
    splitStateOnUnlink(key, keyLinked);
  }

  const linkedOk = linkKeys(selected, key);
  if (!linkedOk) {
    msg(player, "Transposer link failed.");
    selectionByPlayer.delete(player.id);
    return;
  }
  mergeStatesOnLink(selected, key);
  playLinkFx(player, selected, key, false);
  setStateForKey(selected, STATE_LINKED_UNPOWERED);
  setStateForKey(key, STATE_LINKED_UNPOWERED);
  msg(player, "Transposers linked.");
  selectionByPlayer.delete(player.id);
}

export function handleTransposerTunerUseOn(e) {
  try {
    const player = e?.source || e?.player;
    const block = resolveBlockFromEvent(e) || resolveBlockFromView(player);
    if (!player || !block) return;
    handleLinkWithBlock(player, block);
  } catch {
    // ignore
  }
}

export function handleTransposerTunerUse(e) {
  try {
    const player = e?.source || e?.player;
    if (!player) return;
    const block = resolveBlockFromView(player);
    if (!block) {
      msg(player, "Aim at a transposer.");
      return;
    }
    handleLinkWithBlock(player, block);
  } catch {
    // ignore
  }
}
