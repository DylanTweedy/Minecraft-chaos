# Phase Contract

1. **Discovery / Graph Maintenance**
   - Inputs: world prism/beam state, registry events, cached graph.
   - Outputs: authoritative prism graph (nodes, straight edges, lengths, epochs) + rebuild metadata.
   - Side effects: rebuild/validate edges, persist graph when dirty, emit trace insight, enqueue beam jobs.

2. **Indexing**
   - Inputs: current graph nodes, prism filters, endpoint types.
   - Outputs: `filterIndex` + endpoint index (crucible/crystallizer) for routing lookups.
   - Side effects: mark indexes refreshed, no inventory access mutability.

3. **Export Selection**
   - Inputs: budgets, prism levels, cached inventories + filter hints.
   - Outputs: read-only export intents describing itemType/source slot/count.
   - Side effects: counters/reason logging, no container writes.

4. **Destination Resolve**
   - Inputs: export intents + routing services (graph, filter index, endpoints).
   - Outputs: exclusive departure intents per intent (Attuned → Crucible → Drift → None).
   - Side effects: log why intents failed, update counters; never touch inventories.

5. **Arrival**
   - Inputs: spawn/arrival queues, world prism data.
   - Outputs: orb state transitions (AT_PRISM), queued inserts for settlement, XP bookkeeping.
   - Side effects: update `lastHandledPrismKey`, enqueue insight events, keep path info intact.

6. **Departure**
   - Inputs: orbs at prisms, departure intents, graph edges.
   - Outputs: confirmed edge assignments, movement enqueues, drift sink revalidation, walking fallbacks.
   - Side effects: XP noting, drift cursor motion, edge existence asserts; still no container writes.

7. **Inventory IO**
   - Inputs: IO queue extracts/inserts.
   - Outputs: actual container mutations, orb spawns/removals (or retries).
   - Side effects: **only phase allowed to mutate inventories** (extract + insert); handles failures and retries.

8. **Movement / Simulation**
   - Inputs: inflight orbs + edges/speed values.
   - Outputs: progress updates, arrivals posted, drops spawned when edges break.
   - Side effects: advance orbs, emit drop FX, report broken-edge insight.

9. **Flux Conversion**
   - Inputs: drifting/walking/flux orbs on the wire.
   - Outputs: tier upgrades, conversions to flux, hop/speed counters.
   - Side effects: rewrite orb itemTypeId/mode, emit conversion counters.

10. **Persistence + Insight**
   - Inputs: slim state (graph, prisms, drift cursors, orbs) + aggregated metrics.
   - Outputs: persisted dynamic properties + a single insight trace per interval.
   - Side effects: flush graph/orb persistence, summarize metrics, highlight top failure reasons.
