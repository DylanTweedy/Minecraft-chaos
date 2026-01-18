# Chaos Prisms – Transfer System Design (Authoritative)

This document defines the **ground truth mental model** for the Chaos logistics system. Use it while debugging or extending the codebase. If behavior contradicts this doc, the code is wrong.

---

## 1. Core Concepts

### Prism

A **prism is not an inventory**.

A prism is a **network interface and decision node**. It:

- connects to other prisms via beams (graph edges)
- mediates access to attached inventories
- decides *where items go* and *how they move*

A prism may have zero, one, or many attached inventories.

### Inventory

Inventories are **dumb storage** (chests, barrels, furnaces, etc.).

- Items only physically exist here
- Inventories do not decide routing
- All access is mediated by a prism

### Beam / Network

- Beams form a **graph** of prisms (nodes) connected by beam segments (edges).
- Transfers can route across the entire graph.
- Movement is **logical and time-based**, not instantaneous.

#### How beams connect (authoritative intent)
- Beams are **straight-line segments** between prisms.
- An edge exists if two prisms are connected by a valid straight beam segment.
- The graph only needs:
  - prism nodes (positions + dimension)
  - edges (neighbor prism keys + **edge length** + any edge metadata like lenses)

Because beams are straight segments, the graph does **not** need to store every intermediate block position.

Graph is updated on:
  - prism placed/broken
  - beam placed/broken (or beam rebuild pass)
  - world load verification / rebuild

#### Beam integrity and failure
Beams are physical: if an edge is broken, motion must respond.

- **Orbs currently travelling on the broken edge:**
  - drop as **item entities** at/near the break (or at the nearest valid prism endpoint).
  - reason is observable: “beam break dropped orbs”.

- **Orbs that have not yet entered the edge (still at a prism):**
  - are **rerouted** during handover by verifying the next edge exists before departure.

This is easy to implement because the graph already identifies the segment; we can find orbs whose `currentEdgeKey` matches it.

---

## 1C. Failure Handling and Reroute Rules

### Edge-exists check (handover)
Before committing an orb to depart along its chosen next hop:
- verify the **beam block/edge exists** for the adjacent edge.
- if it does not exist:
  - recompute next hop (attuned: find alternate route; drift: advance cursor and pick another edge)
  - if no route exists, fall back to settle/convert rules.

### Items around breaks
- Items already extracted but not safely delivered must remain bounded and observable.
- If an edge breaks mid-flight, those orbs **drop**; nothing silently vanishes.
- If a destination becomes invalid, the orb **reroutes** (bounded) or **converts** under stuck-safe rules.

---

## 1B. Controller Mental Model (Authoritative Phases)

The system runs as a **budgeted controller loop**. Each tick (or scheduled interval), it executes the following phases **in order**. This is the *only* authoritative phase list; all other descriptions in this document refer back to this list.

### Phase 1 — Discovery / Graph Maintenance
- Keeps the prism graph correct when prisms or beams change.
- Triggered by prism placed/broken, beam placed/broken, and world load verification.
- Stores **nodes + straight-line edges + edge length + metadata**.
- No per-block beam storage.

### Phase 2 — Indexing (Filters + Endpoints)
- Builds fast lookup indices from persisted prism state.
- Produces `filterIndex[itemTypeId] -> prismKeys[]` and endpoint lists (crucible, crystallizer).

### Phase 3 — Export Selection (Choose Items)
- Selects **candidate items** from attached inventories under per-prism and global budgets.
- This phase **does not move items**.
- Output is a set of **export intents**: (item, count, source prism).

**Anti-churn rule:** Export Selection may consult lightweight destination availability signals (from Indexing/cached summaries) to avoid generating intents that cannot be routed (especially for drift). The final authority remains Destination Resolve.

### Phase 4 — Destination Resolve (Exclusive)

For each export intent, resolve **exactly one** routing mode:
1. **Attuned** — attempt bounded viable filtered destinations.
2. **Crucible** — if attuned fails and crucibles exist.
3. **Drift** — attempt to choose a **drift destination** (drift sink) among drift-eligible prisms with capacity.
4. **None** — if no viable destination exists (attuned full, no crucible, no drift capacity), **do not queue** a departure. Items remain in inventories.

- This phase decides *where* the item will go.
- Output is a fully-specified **departure intent** (mode + destination/path intent), or **no-op**.

This prevents permanent churn in saturated networks.

### Phase 5 — Arrival (Resolution)
- Runs when an orb is considered to be *at* a prism.
- This includes:
  - true arrivals from movement
  - **spawn-at-source arrivals** for newly exported items
- Responsibilities:
  - award prism XP (+1 per visit, guarded)
  - increment orb hops
  - apply speed ramps / prism boosts
  - drift reroute checks
  - settlement viability checks

> Exported items are treated as having an **Arrival event at their source prism** before departure. This keeps XP, hops, and logic consistent.

### Phase 6 — Departure (Resolution)
- Converts arrival state into motion.
- Chooses next edge (attuned path or drift cursor).
- Verifies edge exists; reroutes if missing.
- Enqueues movement along the chosen edge.

### Phase 7 — Inventory I/O (Budgeted)
- The **only phase** allowed to touch containers.
- Executes queued extracts/inserts safely under budgets.

### Phase 8 — Movement / Simulation
- Advances orbs along edges using edge length + speed.
- Emits Arrival events when endpoints are reached.

### Phase 9 — Flux + Conversion
- Applies gated flux generation, refinement, and conversion.

### Phase 10 — Persistence + Insight
- Flushes slim state.
- Publishes Enhanced Insight (verification, queues, timings, reasons).

---

## 2. Item States

An item/orb is always in exactly one state:

1. **In Inventory** – normal Minecraft storage
2. **In-Flight (Attuned)** – travelling toward a chosen destination
3. **In-Flight (Drift)** – travelling toward a chosen drift sink destination
4. **In-Flight (Walking)** – blocked-state wandering with no viable destination (starts slow, still ramps)
5. **Converted (Flux)** – flux orb created via conversion
6. **Converted (Refined Flux)** – flux that has tiered up through refinement

Prisms control transitions between these states.

---

## 3. Filters (How Order Emerges)

### What a Filter Means

When a player right-clicks a prism with an item:

> “This prism declares intent to accept this item.”

- Filters live on **prisms**, not inventories
- A filtered prism becomes a **network-wide destination** for that item

### Filter Index

For performance, the system maintains:

```
filterIndex[itemTypeId] -> [prismKeys]
```

This allows O(1) destination discovery.

---

## 4. Destination Selection (Primary Rule)

When an item is ready to move:

### Step 1 – Filtered Destinations

- If **any prism anywhere** is filtered for this item:
  - choose a **random matching filtered prism**
  - randomness preserves chaos

### Step 2 – Viability Pre-Check

Before spawning an inflight job:

- does the prism have attached inventories?
- does *any* slot accept the item?

If viable → commit to destination.

### Step 3 – Bounded Attempts

- try a limited number of filtered prisms
- prevents pathological scanning

---

## 5. Overflow Handling

If **all matching filtered prisms are full**:

1. Route to a **Crucible** (if any exist)
2. Otherwise, enter **Drift**

---

## 6. Drift (Controlled Chaos)

Drift exists to keep motion interesting without becoming pointless churn. The system must avoid a state where *everything is always in-flight* and inventories are perpetually empty.

### Drift should prefer a destination (not endless wandering)
Default behavior: a drifting orb should **choose a destination prism** (a “drift sink”) when possible, and only fall back to random-walk motion when no destination is currently viable.

**Drift destination selection (in Destination Resolve):**
- Build a candidate list of **unfiltered prisms** (or any prisms explicitly marked as drift-eligible).
- Prefer candidates that have **any attached inventory with available space** for the item.
- Choose one candidate (random or weighted), and spawn the orb with `mode=drift` and `destPrismKey=...`.

**Fallback:** If no drift-eligible destination is viable, spawn the orb in **drift-wander fallback** mode (no destination) or do not spawn (see Export gating below).

### Export gating (prevent churn)
A prism must **not** queue drift exports if there is nowhere for drift items to go.

Before queuing a drift export intent, check one of:
- **Fast check:** Is there at least one drift-eligible prism with capacity for the item (bounded attempts using cached summaries)?
- **Conservative check:** Is there any drift-eligible prism at all with inventories that are not known-full (TTL summary)?

If the check fails → **do not export** (leave items in inventories).

This prevents the “tier 5 empties everything into inflight forever” failure mode.

### Walking (blocked-state wandering)
Walking is the state for items that currently have **nowhere viable to go**.

- A drift orb becomes **Walking** when it cannot find a viable drift destination.
- Walking uses round-robin cursor movement (backtracking allowed).
- Walking exists to keep the system alive while signalling congestion.

### Visual congestion indicator (slow-start + still ramps)
Walking orbs should **start slow**, but they still:
- gain prism speed boosts while travelling
- ramp speed with hops over time

This makes congestion readable (slow at first) while still allowing the “chaos energy” loop:
blocked items wander → speed up → convert → refine.

When an orb has **no viable destination** (blocked/drift-wander), it should **slow down** (opposite of speed ramp) to create a clear visual signal:
- “fast == healthy flow”
- “slow == nowhere to go / congestion”

### Settlement rules
- drifting items **do not settle on filtered prisms**.
- drifting items may settle on drift-eligible unfiltered prisms when space exists.

Players can read system state by watching orb speed.

---

## 7. Flux (Energy from Motion)

### Flux Generation
- Drifting/Walking items accumulate **flux charge**
- charge increases with hop count and speed
- **flux is gated** until the network is “mature”:
  - no flux generation until **N hops** are reached AND **minimum speed S** is reached
- when threshold crossed → item converts to flux

### Flux Refinement
- Flux orbs continue moving through the network.
- Flux accumulates **refine charge** based on hop count and speed.
- When threshold crossed → tier increases.
- Higher speed → faster refinement.

### Late-game capstone trigger (placeholder)
When **max-tier refined flux** reaches **max speed**, trigger a special event.
- Event design TBD (must be bounded, observable, and performance-safe).
- Examples could include: prism-wide pulse, crystallizer surge, temporary lens amplification, or a rare crafting catalyst.

---

## 8. Prism Progression (Levels)

### XP rule
- Prisms gain **+1 XP per orb visit** (Arrival or Departure, guarded).
- Max level: **5**.
- XP curve is **exponential**.

### Export scaling by level

| Level | Items per export | Export cooldown |
|------:|------------------|-----------------|
| 1 | 1 | 20 ticks |
| 2 | 4 | 15 ticks |
| 3 | 16 | 10 ticks |
| 4 | 32 | 7 ticks |
| 5 | 64 | 5 ticks |

This creates a smooth ramp from slow, granular logistics to high-throughput late-game transport.

### Level effects
- export rate (count + cooldown)
- speed boost to passing orbs (attuned and drift)
- max inflight contribution

---

## 9. Special Endpoints (Conceptual) (Conceptual)

### Crystallizer

- Filtered sink for flux
- Stores and levels via flux input
- Core progression structure

### Crucible

- Overflow sink for any item
- Converts items → flux
- Pressure valve to prevent deadlock

### Network Prestige (Crystallizer-driven)

A late-game progression loop:

- Prestige applies to **all connected prisms** in the network component it is triggered from.
- Prestige should be **spread over time** (budgeted), not instantaneous.

**Suggested implementation (authoritative intent):**

- Triggering prism starts a **prestige queue**.
- Each tick (under a budget), it emits flux out into the network **from the triggering prism**.
- As flux is emitted, the network’s stored XP is **decremented** (and levels fall accordingly) until the component reaches Level 1 / 0 XP baseline.
- The Crystallizer absorbs this prestige flux to grow the **Chaos Crystal**.

This creates an intentional “reset for power” mechanic that fits the system’s theme: order from chaos, then chaos from order.

### Lens

- Beam modifier (edge metadata)
- Amplifies beams
- Color = effect

### Forge

- Consumes flux + beam state
- Uses the network itself as a crafting machine

---

## 9. Design Invariants (Never Break These)

- Prisms are **not inventories**
- Filters define **intent**, not guarantees
- Transfers must always be:
  - bounded
  - observable
  - non-deterministic but non-arbitrary
- **Export routing is exclusive:** Attuned **or** Crucible **or** Drift — never multiple modes for the same export on the same tick
- **All inventory I/O is budgeted and queued** (never unbounded scanning)
- **All orb hop counting happens on prism arrival**
- **Prism XP increments by +1 per handover event** (without double-counting pass-through)
- Drift must *eventually* settle or convert (stuck-safe)

> Nothing is deterministic, but nothing is arbitrary.

---

## 10. Debugging Checklist

When transfers don’t move:

- **Discovery:** is the prism graph correct (edges exist, nodes valid)?
- **Indexing:** does filterIndex contain expected destinations?
- **Planning:** is a destination being selected and is spawn being throttled?
- **Handover:** are orbs arriving, incrementing hops, and deciding next step?
- **Inventory I/O:** are space checks and insert/withdraw requests being queued and serviced?
- **Movement:** are orbs advancing along edges at the expected speed?
- **Persistence/Insight:** are counters and slim state being saved and surfaced?

If code behavior contradicts this document, fix the code—not the design.

---

## 11. Phase Contracts (Readable)

These contracts are the **refactor anchors**. Each phase owns a responsibility, touches specific state, and exposes Insight.

### Phase 1 — Discovery / Graph Maintenance

- **Purpose:** Keep the prism graph correct when prisms change and on world load.
- **Triggered by:** prism placed/broken, rebuild requests, world load verification.
- **Touches (persisted):** Beams/graph DP (nodes + edges).
- **Derived/cached:** Prism list (derived from graph), adjacency lists.
- **Enhanced Insight:** graph version + verification flags, node/edge counts, last rebuild reason/time, rebuild duration.

### Phase 2 — Indexing (Filters + Endpoints)

- **Purpose:** Fast destination discovery.
- **Touches (persisted):** per-prism filters DP; optional endpoint registration DP.
- **Derived/cached:** `filterIndex[itemTypeId] -> prismKeys[]`, endpoint indices (crucibles/crystallizers).
- **Enhanced Insight:** index sizes, rebuild time, invalid/ghost filters, endpoint counts.

### Phase 3 — Export Selection (Choose Items to Move)

- **Purpose:** Choose candidate items from eligible inventories to export, under budgets.
- **Inputs:** attached inventories, per-prism cooldowns, global caps, item eligibility.
- **Outputs:** export candidates (item + source + prism).
- **Enhanced Insight:** candidates scanned, selected, throttled (with top reasons).

### Phase 4 — Destination Resolve (Attuned → Crucible → Drift)

- **Purpose:** For each export candidate, choose **exactly one** routing mode.
- **Rule order (exclusive):**
  1. **Attuned:** if any filtered prism exists for the item, attempt bounded viability checks and pick one.
  2. **Crucible:** if attuned destinations are all full/unviable, route to a crucible if present.
  3. **Drift:** otherwise spawn as drift.
- **Invariant:** a candidate spawns **one orb in one mode** (never “attuned + drift” on the same tick).
- **Enhanced Insight:** attuned hits/misses, crucible used, drift spawned, viability failure reasons.

### Phase 5 — Arrival (Resolution)

- Runs when an orb reaches a prism **or when an export is spawned at its source prism**.
- Awards XP if this is a new visit:
  - if `orb.lastHandledPrismKey !== thisPrismKey`, then `prismXP++` and set `orb.lastHandledPrismKey = thisPrismKey`.
- Increments orb hops.
- Applies speed ramp and prism speed boost.
- Runs drift reroute checks.
- Performs settlement viability checks (may enqueue inventory I/O).

**Enhanced Insight:** arrivals, spawn-arrivals, hop totals, reroutes, settle attempts/fails.

### Phase 6 — Departure (Resolution)

- Runs when an orb is ready to leave a prism.
- Awards XP **only if not already awarded for this visit** (same guard).
- Chooses next hop:
  - attuned: follow or recompute route
  - drift: round-robin cursor
- Verifies beam edge exists; reroutes if missing (bounded).

**Enhanced Insight:** departures, reroutes, missing-edge events, cursor position.

### Phase 6 — Inventory I/O (Budgeted)

- **Purpose:** Perform queued inventory checks/inserts/extracts safely under budgets.
- **Touches (persisted):** minimal replay-safe queue/journal only if needed.
- **Derived/cached:** per-container slot rules, short-lived reservation maps.
- **Enhanced Insight:** queue depth, ops/sec, failures by type (full/invalid/locked), budget usage.

### Phase 7 — Movement / Simulation

- **Purpose:** Advance orbs along edges and emit arrivals.
- **Rules:**
  - **Attuned speed ≈ 50% faster** than drift at baseline.
  - Both scale with prism level boosts.
- **Touches (persisted):** orb DP (minimal position/ETA/state).
- **Enhanced Insight:** inflight count, avg speed, stuck detection flags.

### Phase 8 — Flux + Conversion

- **Purpose:** Convert motion into flux in a controlled, non-spammy way.
- **Flux gating rule:** prevent flux generation until **both** are true:
  - orb has at least **N hops** (network maturity gate)
  - orb speed is at least **S** (behavioral gate)

This ensures early/basic networks don’t get flooded with flux; flux emerges as networks scale.

### Phase 9 — Persistence + Telemetry

- **Purpose:** Save slim state and publish Insight summaries.
- **Enhanced Insight (prism):** load verification, active tasks/queues, phase timings (last + rolling), top failure/throttle reasons.

---

## 12. Intended Storage (What lives where)

### Persisted (must survive reload)
- Prism graph: nodes + edges + edge length + metadata
- Prism XP / level
- Drift cursor (or deterministic equivalent)
- Filters per prism
- Active orbs (minimal: item, count, mode, edge, progress, speed, hops, lastHandledPrismKey)

### Derived / rebuildable
- Prism list
- filterIndex
- endpoint indices

### Ephemeral (per tick)
- Budgets, cooldowns
- Queues (export intents, departures, inventory I/O)
- Insight aggregates

---

## 13. Design Improvements (Incorporated)

1. **Export vs Extraction separation** — selection never mutates inventories.
2. **Lightweight destination reservation** — prevents thrashing without full virtual inventories.
3. **Defined beam-break drop rule** — broken edges drop in-flight orbs observably.
4. **Graph-first edge validation** — block scans only on rebuild/desync.
5. **Explicit XP + prestige accounting** — XP curves, conversion rules, and prestige effects are deterministic and inspectable.

