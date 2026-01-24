// scripts/chaos/features/logistics/runtime/registry/linkGraph.js
import { BEAM_ID, MAX_BEAM_LEN, isPrismBlock, isEndpointId, getPrismTier } from "../../config.js";
import { beamAxisMatchesDir } from "../../network/beams/axis.js";
import { key, parseKey } from "../../keys.js";
import { loadLinkGraph, saveLinkGraph } from "../../persistence/storage.js";
import { enqueueBuildJob, enqueueCollapseJob } from "../../network/beams/jobs.js";

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v | 0));
}

function edgeIdFor(aKey, bKey) {
  return (String(aKey) <= String(bKey)) ? `${aKey}->${bKey}` : `${bKey}->${aKey}`;
}

function deriveDirFromKeys(aKey, bKey) {
  const a = parseKey(aKey);
  const b = parseKey(bKey);
  if (!a || !b) return { dx: 0, dy: 0, dz: 0 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return { dx: Math.sign(dx), dy: Math.sign(dy), dz: Math.sign(dz) };
}

function normalizeEdgeEndpoints(aKey, bKey, dir) {
  if (String(aKey) <= String(bKey)) return { aKey, bKey, dir };
  return { aKey: bKey, bKey: aKey, dir: { dx: -dir.dx, dy: -dir.dy, dz: -dir.dz } };
}

function isNodeBlock(block) {
  if (!block) return false;
  if (isPrismBlock(block)) return true;
  return isEndpointId(block.typeId);
}

function getNodeType(block) {
  if (!block) return null;
  if (isPrismBlock(block)) return "prism";
  if (isEndpointId(block.typeId)) return "endpoint";
  return null;
}

export function createLinkGraph(deps) {
  const world = deps?.world;
  const cfg = deps?.cfg || {};

  const edges = new Map();
  const adjacency = new Map();
  const dirtyPrisms = new Set();
  const segmentToEdges = new Map();
  let diagCollector = null;

  let graphStamp = 0;
  let dirty = false;

  function bumpStamp() {
    graphStamp++;
  }

  function markDirty() {
    dirty = true;
    bumpStamp();
  }

  function addAdjacency(nodeKey, edgeId) {
    if (!adjacency.has(nodeKey)) adjacency.set(nodeKey, new Set());
    adjacency.get(nodeKey).add(edgeId);
  }

  function removeAdjacency(nodeKey, edgeId) {
    const set = adjacency.get(nodeKey);
    if (!set) return;
    set.delete(edgeId);
    if (set.size === 0) adjacency.delete(nodeKey);
  }

  function addSegmentMapping(edgeId, edge) {
    const segs = getEdgeSegments(edge);
    for (const pos of segs) {
      const segKey = key(edge.dimId, pos.x, pos.y, pos.z);
      if (!segmentToEdges.has(segKey)) segmentToEdges.set(segKey, new Set());
      segmentToEdges.get(segKey).add(edgeId);
    }
  }

  function removeSegmentMapping(edgeId, edge) {
    const segs = getEdgeSegments(edge);
    for (const pos of segs) {
      const segKey = key(edge.dimId, pos.x, pos.y, pos.z);
      const set = segmentToEdges.get(segKey);
      if (!set) continue;
      set.delete(edgeId);
      if (set.size === 0) segmentToEdges.delete(segKey);
    }
  }

  function getEdgeSegments(edge) {
    const parsedA = parseKey(edge.aKey);
    if (!parsedA || edge.length <= 1) return [];
    const segs = [];
    for (let i = 1; i < edge.length; i++) {
      segs.push({
        x: parsedA.x + edge.dir.dx * i,
        y: parsedA.y + edge.dir.dy * i,
        z: parsedA.z + edge.dir.dz * i,
      });
    }
    return segs;
  }

  function enqueueBuild(edge) {
    if (edge.length <= 1) return;
    const parsedA = parseKey(edge.aKey);
    const parsedB = parseKey(edge.bKey);
    if (!parsedA || !parsedB) return;
    enqueueBuildJob({
      fromKey: edge.aKey,
      toKey: edge.bKey,
      dimId: edge.dimId,
      from: { x: parsedA.x, y: parsedA.y, z: parsedA.z },
      to: { x: parsedB.x, y: parsedB.y, z: parsedB.z },
      dir: edge.dir,
      len: edge.length,
      step: 1,
      tier: edge.tier,
    });
  }

  function enqueueCollapse(edge) {
    if (edge.length <= 1) return;
    const parsedA = parseKey(edge.aKey);
    const parsedB = parseKey(edge.bKey);
    if (!parsedA || !parsedB) return;
    enqueueCollapseJob({
      fromKey: edge.aKey,
      toKey: edge.bKey,
      dimId: edge.dimId,
      from: { x: parsedA.x, y: parsedA.y, z: parsedA.z },
      to: { x: parsedB.x, y: parsedB.y, z: parsedB.z },
      dir: edge.dir,
      len: edge.length,
    });
  }

  function addOrUpdateEdge(edge, nowTick) {
    const id = edge.edgeId;
    const existing = edges.get(id);
    if (existing) {
      existing.length = edge.length;
      existing.dir = edge.dir;
      existing.tier = edge.tier;
      existing.pendingUntilTick = existing.pendingUntilTick || edge.pendingUntilTick;
      return existing;
    }

    edges.set(id, edge);
    addAdjacency(edge.aKey, id);
    addAdjacency(edge.bKey, id);
    addSegmentMapping(id, edge);
    enqueueBuild(edge);
    markDirty();
    return edge;
  }

  function removeEdge(edge, reason = "removed") {
    if (!edge) return;
    edges.delete(edge.edgeId);
    removeAdjacency(edge.aKey, edge.edgeId);
    removeAdjacency(edge.bKey, edge.edgeId);
    removeSegmentMapping(edge.edgeId, edge);
    enqueueCollapse(edge);
    edge.epoch = (edge.epoch | 0) + 1;
    edge.state = "broken";
    edge.reason = reason;
    markDirty();
  }

  function isEdgeBeamComplete(edge) {
    if (edge.length <= 1) return true;
    const parsedA = parseKey(edge.aKey);
    if (!parsedA) return false;
    const dim = world?.getDimension?.(edge.dimId);
    if (!dim) return false;
    for (let i = 1; i < edge.length; i++) {
      const b = dim.getBlock({
        x: parsedA.x + edge.dir.dx * i,
        y: parsedA.y + edge.dir.dy * i,
        z: parsedA.z + edge.dir.dz * i,
      });
      if (!b || b.typeId !== BEAM_ID) return false;
    }
    return true;
  }

  function isEdgeEndpointsValid(edge) {
    const parsedA = parseKey(edge.aKey);
    const parsedB = parseKey(edge.bKey);
    if (!parsedA || !parsedB) return false;
    const dim = world?.getDimension?.(edge.dimId);
    if (!dim) return false;
    const blockA = dim.getBlock({ x: parsedA.x, y: parsedA.y, z: parsedA.z });
    const blockB = dim.getBlock({ x: parsedB.x, y: parsedB.y, z: parsedB.z });
    return isNodeBlock(blockA) && isNodeBlock(blockB);
  }

  function buildEdgeFromScan(fromKey, fromPos, dir, length, tier, nowTick) {
    const toKey = key(fromPos.dimId, fromPos.x + dir.dx * length, fromPos.y + dir.dy * length, fromPos.z + dir.dz * length);
    const normalized = normalizeEdgeEndpoints(fromKey, toKey, dir);
    const id = edgeIdFor(normalized.aKey, normalized.bKey);
    return {
      edgeId: id,
      aKey: normalized.aKey,
      bKey: normalized.bKey,
      dimId: fromPos.dimId,
      dir: normalized.dir,
      length: length | 0,
      tier,
      state: "pending",
      epoch: 1,
      pendingUntilTick: (nowTick | 0) + clampInt(cfg.linkBuildTicks, 1, 200),
      lastValidatedTick: 0,
    };
  }

  function scanEdgeFromNode(dim, nodePos, dir) {
    let sawBeam = false;
    for (let i = 1; i <= MAX_BEAM_LEN; i++) {
      const x = nodePos.x + dir.dx * i;
      const y = nodePos.y + dir.dy * i;
      const z = nodePos.z + dir.dz * i;
      const b = dim.getBlock({ x, y, z });
      if (!b) {
        if (diagCollector && sawBeam) {
          diagCollector({ code: "Other", blockId: "none", at: i });
        }
        break;
      }
      const id = b.typeId;
      if (id === "minecraft:air") continue;
      if (id === BEAM_ID) {
        sawBeam = true;
        if (!beamAxisMatchesDir(b, dir.dx, dir.dy, dir.dz)) {
          if (diagCollector) {
            diagCollector({ code: "NotStraight", blockId: id, at: i });
          }
          return null;
        }
        continue;
      }
      if (isNodeBlock(b)) {
        return { len: i, nodeType: getNodeType(b) };
      }
      if (diagCollector) {
        const code = sawBeam ? "Obstructed" : "WrongBlock";
        diagCollector({ code, blockId: id, at: i });
      }
      break;
    }
    if (diagCollector && sawBeam) {
      diagCollector({ code: "NoEndpoint", blockId: "none", at: MAX_BEAM_LEN });
    }
    return null;
  }

  function rebuildEdgesForKey(nodeKey, nowTick) {
    const parsed = parseKey(nodeKey);
    if (!parsed) return { updated: false, added: 0, removed: 0 };
    const dim = world?.getDimension?.(parsed.dimId);
    if (!dim) return { updated: false, added: 0, removed: 0 };

    const block = dim.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!isNodeBlock(block)) {
      const toRemove = getEdgesForNode(nodeKey);
      for (const edge of toRemove) removeEdge(edge, "node_missing");
      return { updated: toRemove.length > 0, added: 0, removed: toRemove.length };
    }

    const fromPos = { dimId: parsed.dimId, x: parsed.x, y: parsed.y, z: parsed.z };
    const tier = getPrismTier(block);
    const dirs = [
      { dx: 1, dy: 0, dz: 0 },
      { dx: -1, dy: 0, dz: 0 },
      { dx: 0, dy: 0, dz: 1 },
      { dx: 0, dy: 0, dz: -1 },
      { dx: 0, dy: 1, dz: 0 },
      { dx: 0, dy: -1, dz: 0 },
    ];

    const found = new Set();
    let added = 0;
    for (const d of dirs) {
      const hit = scanEdgeFromNode(dim, fromPos, d);
      if (!hit) continue;
      const edge = buildEdgeFromScan(nodeKey, fromPos, d, hit.len, tier, nowTick);
      found.add(edge.edgeId);
      if (!edges.has(edge.edgeId)) {
        addOrUpdateEdge(edge, nowTick);
        added++;
      }
    }

    const existing = getEdgesForNode(nodeKey);
    let removed = 0;
    for (const e of existing) {
      if (!found.has(e.edgeId)) {
        removeEdge(e, "edge_missing");
        removed++;
      }
    }

    return { updated: added > 0 || removed > 0, added, removed };
  }

  function getEdgesForNode(nodeKey) {
    const ids = adjacency.get(nodeKey);
    if (!ids) return [];
    const list = [];
    for (const id of ids) {
      const edge = edges.get(id);
      if (edge) list.push(edge);
    }
    return list;
  }

  function validateEdgesBudgeted(budget, nowTick) {
    let processed = 0;
    const ids = Array.from(edges.keys());
    const max = Math.min(ids.length, budget);
    for (let i = 0; i < max; i++) {
      const id = ids[(nowTick + i) % ids.length];
      const edge = edges.get(id);
      if (!edge) continue;
      edge.lastValidatedTick = nowTick;

      const endpointsOk = isEdgeEndpointsValid(edge);
      if (!endpointsOk) {
        removeEdge(edge, "endpoint_missing");
        processed++;
        continue;
      }

      if (edge.state === "pending") {
        if ((nowTick | 0) >= (edge.pendingUntilTick | 0)) {
          if (isEdgeBeamComplete(edge)) {
            edge.state = "active";
            markDirty();
          } else {
            removeEdge(edge, "beam_missing");
          }
        }
      } else if (edge.state === "active") {
        if (!isEdgeBeamComplete(edge)) {
          removeEdge(edge, "beam_missing");
        }
      }

      processed++;
    }
    return { processed };
  }

  function markNodeDirty(nodeKey) {
    if (!nodeKey) return;
    dirtyPrisms.add(nodeKey);
  }

  function rebuildDirtyBudgeted(budget, nowTick) {
    let processed = 0;
    while (processed < budget && dirtyPrisms.size > 0) {
      const iter = dirtyPrisms.values();
      const nodeKey = iter.next().value;
      dirtyPrisms.delete(nodeKey);
      rebuildEdgesForKey(nodeKey, nowTick);
      processed++;
    }
    return { processed, remaining: dirtyPrisms.size };
  }

  function handleBeamBreakAt(dimId, loc) {
    const segKey = key(dimId, loc.x, loc.y, loc.z);
    const set = segmentToEdges.get(segKey);
    if (!set) return 0;
    let invalidated = 0;
    for (const id of set) {
      const edge = edges.get(id);
      if (!edge) continue;
      removeEdge(edge, "beam_break");
      invalidated++;
    }
    return invalidated;
  }

  function hasNode(nodeKey) {
    if (!nodeKey) return false;
    return adjacency.has(nodeKey);
  }

  function getNeighbors(nodeKey, opts = null) {
    const includePending = !!opts?.includePending;
    const list = [];
    for (const edge of getEdgesForNode(nodeKey)) {
      if (edge.state !== "active" && !(includePending && edge.state === "pending")) continue;
      const other = edge.aKey === nodeKey ? edge.bKey : edge.aKey;
      list.push({
        edgeId: edge.edgeId,
        key: other,
        length: edge.length,
        dir: edge.aKey === nodeKey ? edge.dir : { dx: -edge.dir.dx, dy: -edge.dir.dy, dz: -edge.dir.dz },
        state: edge.state,
        epoch: edge.epoch,
      });
    }
    return list;
  }

  function getGraphStamp() {
    return graphStamp | 0;
  }

  function getEdge(edgeId) {
    return edges.get(edgeId) || null;
  }

  function getEdgeBetweenKeys(aKey, bKey) {
    if (!aKey || !bKey) return null;
    const id = edgeIdFor(aKey, bKey);
    return edges.get(id) || null;
  }

  function getGraphStats() {
    return {
      prisms: adjacency.size,
      edges: edges.size,
    };
  }

  function getNodeKeys() {
    return Array.from(adjacency.keys());
  }

  function buildPathFromParents(startKey, endKey, parentMap) {
    const steps = [];
    let curKey = endKey;
    while (curKey && curKey !== startKey) {
      const info = parentMap.get(curKey);
      if (!info) break;
      steps.push(info);
      curKey = info.prevKey;
    }
    if (curKey !== startKey) return null;
    steps.reverse();

    const parsedStart = parseKey(startKey);
    if (!parsedStart) return null;
    const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];

    for (const step of steps) {
      const edge = edges.get(step.edgeId);
      if (!edge) return null;
      const from = parseKey(step.prevKey);
      const to = parseKey(step.key);
      if (!from || !to) return null;
      const dir = step.prevKey === edge.aKey ? edge.dir : { dx: -edge.dir.dx, dy: -edge.dir.dy, dz: -edge.dir.dz };
      for (let i = 1; i < edge.length; i++) {
        forward.push({ x: from.x + dir.dx * i, y: from.y + dir.dy * i, z: from.z + dir.dz * i });
      }
      forward.push({ x: to.x, y: to.y, z: to.z });
    }

    return forward;
  }

  function persistIfDirty() {
    if (!dirty) return false;
    const list = [];
    for (const edge of edges.values()) {
      list.push({
        aKey: edge.aKey,
        bKey: edge.bKey,
        dimId: edge.dimId,
        length: edge.length,
        meta: { tier: edge.tier | 0 },
      });
    }
    saveLinkGraph(world, list);
    dirty = false;
    return true;
  }

  function loadFromStorage() {
    const stored = loadLinkGraph(world);
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
      if (!entry || typeof entry !== "object") continue;
      const id = entry.edgeId || edgeIdFor(entry.aKey, entry.bKey);
      if (!entry.aKey || !entry.bKey || !entry.dimId) continue;
      const metaTier = entry.meta?.tier ?? entry.tier;
      const edge = {
        edgeId: id,
        aKey: entry.aKey,
        bKey: entry.bKey,
        dimId: entry.dimId,
        dir: entry.dir || deriveDirFromKeys(entry.aKey, entry.bKey),
        length: entry.length | 0,
        tier: metaTier | 0,
        state: "pending",
        epoch: 1,
        pendingUntilTick: 0,
        lastValidatedTick: 0,
      };
      edges.set(edge.edgeId, edge);
      addAdjacency(edge.aKey, edge.edgeId);
      addAdjacency(edge.bKey, edge.edgeId);
      addSegmentMapping(edge.edgeId, edge);
    }
  }

  loadFromStorage();

  return {
    getGraphStamp,
    getEdge,
    getEdgeBetweenKeys,
    getNeighbors,
    buildPathFromParents,
    markNodeDirty,
    rebuildDirtyBudgeted,
    validateEdgesBudgeted,
    handleBeamBreakAt,
    persistIfDirty,
    getGraphStats,
    getNodeKeys,
    getGraphSampleKeys(count = 3) {
      const keys = Array.from(adjacency.keys());
      return keys.slice(0, Math.max(0, Math.min(count, keys.length)));
    },
    hasNode,
    setDiagnosticsCollector(fn) {
      diagCollector = typeof fn === "function" ? fn : null;
    },
  };
}


