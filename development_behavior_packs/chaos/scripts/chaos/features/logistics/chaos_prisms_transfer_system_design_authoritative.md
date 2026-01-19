# Chaos Prisms – Transfer System Design (Authoritative)

This document defines the **ground truth mental model** for the Chaos logistics system. Use it while debugging or extending the codebase. If behavior contradicts this doc, the code is wrong.

---

## 1. Core Concepts

### Prism

A **prism is not an inventory**.

A prism is a **network interface and decision node**. It:

* connects to other prisms via beams (graph edges)
* mediates access to attached inventories
* decides *where items go* and *how they move*

A prism may have zero, one, or many attached inventories.

### Inventory

Inventories are **dumb storage** (chests, barrels, furnaces, etc.).

* Items only physically exist here
* Inventories do not decide routing
* All access is mediated by a prism

---

## 2. Beams and Network Graph

### Beam / Network

* Beams form a **graph** of prisms (nodes) connected by straight beam segments (edges).
* Transfers can route across the entire graph.
* Movement is **logical and time-based**, not instantaneous.

### How beams connect (authoritative intent)

* Beams are **straight-line segments** between prisms.
* An edge exists if two prisms are connected by a valid straight beam segment.
* The graph stores only:

  * prism nodes (position + dimension)
  * edges (neighbor prism key + **edge length** + edge metadata like lenses)
* The graph does **not** store intermediate beam block positions.

### Graph update triggers

* prism placed/broken
* beam placed/broken (or beam rebuild pass)
* world load verification / rebuild

### Beam integrity and failure

Beams are physical: if an edge is broken, motion must respond.

* **Orbs currently travelling on the broken edge**

  * drop as **item entities** at a defined drop location.
  * the drop reason must be observable (Insight + FX).

* **Orbs that have not yet entered the edge (still at a prism)**

  * are **rerouted** during Departure by verifying the next edge exists before committing.

**Drop location rule (must be consistent):** choose one and stick to it.

* Option A: drop at nearest endpoint prism.
* Option B: drop at the computed position along the segment based on orb progress.

---

## 3. Failure Handling and Reroute Rules

### Edge-exists check (Departure)

Before committing an orb to depart along its chosen next hop:

* verify the **edge exists** (graph-first) and neighbor prism is valid.
* if missing:

  * recompute next hop (attuned: alternate route; drift/walking: advance cursor)
  * if no route exists, fall back to settle/convert rules.

### Items around breaks

* Items already extracted but not safely delivered must remain bounded and observable.
* If an edge breaks mid-flight, those orbs **drop**; nothing silently vanishes.
* If a destination becomes invalid/full, the orb **reroutes** (bounded) or transitions to Walking/Conversion under stuck-safe rules.

---

## 4. Controller Phases (Single Authoritative List)

The system runs as a **budgeted controller loop**. Each tick (or scheduled interval), it executes these phases **in order**.

### Phase 1 — Discovery / Graph Maintenance

* Keep prism graph correct when prisms or beams change.
* Persist: nodes + straight edges + edge length + metadata.
* Enhanced Insight: graph version/verification flags, node/edge counts, rebuild reason/time, rebuild duration.

### Phase 2 — Indexing (Filters + Endpoints)

* Build fast lookup indices from persisted prism state.
* Produces:

  * `filterIndex[itemTypeId] -> prismKeys[]`
  * endpoint indices (crucible, crystallizer, etc.)
* Enhanced Insight: index sizes, rebuild time, invalid/ghost filters, endpoint counts.

### Phase 3 — Export Selection (Read-only intent building)

* Choose **candidate items** from attached inventories under per-prism + global budgets.
* This phase may perform **bounded read-only inspection**.
* Output: **export intents** (itemType, plannedCount, source prism/inventory).
* Anti-churn: may consult lightweight destination availability signals, but **Destination Resolve is the final authority**.
* Enhanced Insight: candidates scanned, selected, throttled, top reasons.

### Phase 4 — Destination Resolve (Exclusive)

For each export intent, resolve **exactly one** outcome:

1. **Attuned** — bounded attempt at viable filtered destinations.
2. **Crucible** — if attuned fails and crucibles exist.
3. **Drift** — choose a viable drift sink among drift-eligible prisms with capacity.
4. **None** — if no viable destination exists, **do not queue** a departure (items stay put).

Output: **departure intent** (mode + destination/path intent) or no-op.

Enhanced Insight: attuned hits/misses, crucible usage, drift sink selection, viability failure reasons, none/no-op counts.

### Phase 5 — Arrival (Resolution)

Runs when an orb is considered to be *at* a prism:

* true arrivals from Movement
* **spawn-at-source arrivals** for newly exported items

Responsibilities:

* orb hop increment
* apply speed ramps / prism boosts
* drift reroute checks
* settlement viability checks (may enqueue Inventory Mutations)
* award prism XP **if not already awarded for this prism visit** (guarded)

Guard:

* if `orb.lastHandledPrismKey !== thisPrismKey` then award XP and set it.

Enhanced Insight: arrivals, spawn-arrivals, hop totals, reroutes, settle attempts/fails.

### Phase 6 — Departure (Resolution)

* Choose next hop:

  * attuned: follow or recompute route
  * drift: head toward drift sink
  * walking: round-robin cursor wandering
* Verify edge exists; reroute if missing (bounded).
* Award XP only if not already awarded for this prism visit (same guard).
* Enqueue movement along chosen edge.

Enhanced Insight: departures, reroutes, missing-edge events, cursor position.

### Phase 7 — Inventory Mutations (Budgeted, authoritative truth)

The **only phase** allowed to mutate containers.

* Execute queued extracts/inserts under budgets.
* All “pre-checks” can be wrong; this phase is the final authority.

Enhanced Insight: queue depth, ops/sec, failures by type (full/invalid/locked), budget usage, precheck-failed rate.

### Phase 8 — Movement / Simulation

* Advance orbs along edges using edge length + speed.
* Emit Arrival events when endpoints are reached.

Enhanced Insight: inflight count, avg speed, blocked/walking count, stuck flags.

### Phase 9 — Flux + Conversion

* Apply gated conversion/refinement rules.

Enhanced Insight: conversions, refinements, gating reasons.

### Phase 10 — Persistence + Insight

* Flush slim state.
* Publish Enhanced Insight (verification, queues, timings, reasons).

---

## 5. Item States

An item/orb is always in exactly one state:

1. **In Inventory** – normal Minecraft storage
2. **In-Flight (Attuned)** – travelling toward a chosen filtered destination
3. **In-Flight (Drift)** – travelling toward a chosen drift sink destination
4. **In-Flight (Walking)** – wandering because no viable destination exists (starts slow, still ramps)
5. **Converted (Flux)** – flux orb created via conversion
6. **Converted (Refined Flux)** – flux that has tiered up through refinement

Prisms control transitions between these states.

---

## 6. Filters (How Order Emerges)

### What a Filter Means

When a player right-clicks a prism with an item:

> “This prism declares intent to accept this item.”

* Filters live on **prisms**, not inventories.
* A filtered prism becomes a **network-wide destination** for that item.

### Filter Index

For performance, maintain:

```
filterIndex[itemTypeId] -> [prismKeys]
```

This allows O(1) destination discovery.

---

## 7. Routing (Attuned → Crucible → Drift → None)

Routing is exclusive per export intent:

1. **Attuned**

* if any prism is filtered for this item, attempt bounded destination selection
* pre-check viability (attached inventories + acceptance)

2. **Crucible**

* if attuned destinations are all full/unviable, route to crucible if any exist

3. **Drift**

* choose a viable drift sink among drift-eligible prisms with capacity

4. **None**

* if nothing is viable, do not export; items remain in inventories

---

## 8. Drift and Walking (Controlled Chaos)

### Drift prefers a destination

Default drift chooses a **drift sink** (destination prism) when possible.

### Walking is the blocked-state behavior

Walking is for items with **nowhere viable to go**:

* starts slow (clear congestion signal)
* still gains prism speed boosts and hop-based ramp over time
* uses round-robin cursor wandering (backtracking allowed)

### Anti-churn rule

If no drift sink exists and no other route exists, **do not export** (Destination Resolve returns None). Walking is primarily for **mid-flight** congestion (e.g., destination becomes invalid/full).

### Settlement rules

* drift/walking items **do not** settle on filtered prisms
* drift/walking items may settle on drift-eligible unfiltered prisms when space exists

---

## 9. Flux (Energy from Motion)

### Flux Generation

* Drift/Walking items accumulate **flux charge**
* charge increases with hop count and speed
* **flux is gated** until network maturity:

  * at least **N hops** and at least **speed S**
* when threshold crossed → item converts to flux

### Flux Refinement

* Flux continues moving through the network.
* Flux accumulates **refine charge** based on hop count and speed.
* When threshold crossed → tier increases.
* Higher speed → faster refinement.

### Late-game capstone trigger (placeholder)

When **max-tier refined flux** reaches **max speed**, trigger a special bounded event.

* Event design TBD (bounded, observable, performance-safe).

---

## 10. Prism Progression (Levels)

### XP rule

* Prisms gain **+1 XP per orb visit** (Arrival or Departure, guarded by `lastHandledPrismKey`).
* Max level: **5**.
* XP curve is **exponential**.

### Export scaling by level

| Level | Items per export | Export cooldown |
| ----: | ---------------- | --------------- |
|     1 | 1                | 20 ticks        |
|     2 | 4                | 15 ticks        |
|     3 | 16               | 10 ticks        |
|     4 | 32               | 7 ticks         |
|     5 | 64               | 5 ticks         |

### Level effects

* export rate (count + cooldown)
* speed boost to passing orbs (attuned/drift/walking)
* max inflight contribution

---

## 11. Special Endpoints (Conceptual)

### Crystallizer

* filtered sink for flux
* stores and levels via flux input
* core progression structure

### Crucible

* overflow sink for any item
* converts items → flux
* pressure valve to prevent deadlock

### Network Prestige (Crystallizer-driven)

* applies to **all connected prisms** in the component triggered from
* spread over time (budgeted)
* triggering prism runs a **prestige queue**:

  * emits flux into the network over time
  * decrements stored XP/levels until baseline
* crystallizer absorbs prestige flux to grow the **Chaos Crystal**

### Lens

* beam modifier (edge metadata)
* amplifies beams
* color = effect

### Forge

* consumes flux + beam state
* uses the network itself as a crafting machine

---

## 12. Visual FX (Particles)

Particles must be readable and state-linked:

* **Arrival:** orb reaches a prism
* **Departure:** orb commits to a hop and leaves prism
* **Beam Break:** edge broken and in-flight orbs drop
* **Walking:** subtle stalled/walking pulse
* **Converting:** item converts to flux
* **Refining:** flux tiers up

---

## 13. Design Invariants (Never Break These)

* Prisms are **not inventories**.
* Filters define **intent**, not guarantees.
* Transfers must be:

  * bounded
  * observable
  * non-deterministic but non-arbitrary
* Export routing is exclusive: **Attuned OR Crucible OR Drift OR None** per export intent.
* Only Phase 7 mutates inventories.
* Orbs never vanish silently: broken edges drop orbs; failures reroute or convert.
* Drift/walking never settle on filtered prisms.

> Nothing is deterministic, but nothing is arbitrary.

---

## 14. Debugging Checklist

When transfers don’t move:

* **Graph:** edges/nodes correct? (counts + verification flags)
* **Indices:** filterIndex correct for item? endpoint indices populated?
* **Export:** are intents being selected or throttled?
* **Resolve:** are intents resolving to Attuned/Crucible/Drift/None as expected?
* **Arrival/Departure:** are hops/XP incrementing and reroutes occurring?
* **Inventory Mutations:** are ops executing, and are failures explained?
* **Movement:** are orbs advancing, or are many in Walking?
* **Persistence/Insight:** are timings/reasons visible and sensible?

If behavior contradicts this document, fix the code—not the design.

---

## 15. Intended Storage (What lives where)

### Persisted (must survive reload)

* Prism graph: nodes + edges + edge length + metadata
* Prism XP / level
* Drift cursor (or deterministic equivalent)
* Filters per prism
* Active orbs (minimal: item, count, mode, edge, progress, speed, hops, lastHandledPrismKey)

### Derived / rebuildable

* Prism list
* filterIndex
* endpoint indices

### Ephemeral (per tick)

* Budgets, cooldowns
* Queues (export intents, departures, inventory mutation requests)
* Insight aggregates

---

## 16. Design Improvements (Incorporated)

1. Export vs extraction separation (selection never mutates inventories).
2. Lightweight destination reservation to reduce thrash.
3. Defined beam-break drop rule (consistent drop location).
4. Graph-first edge validation (block scans only on rebuild/desync).
5. Explicit XP + prestige accounting (deterministic and inspectable).
