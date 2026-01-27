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

### Inventory Adapters (Special Blocks)

Some inventories have slot rules. Adapters are used to enforce them while still
obeying the phase constraints (read-only in Phases 3-4, mutations only in Phase 8).

**Furnace family (furnace, blast furnace, smoker):**

* Input slot: 0 (smeltables)
* Fuel slot: 1 (fuel items)
* Output slot: 2 (extract only)

Attuned/filter mechanics still apply. If a prism is attached to a furnace-style
block, exports only read from the output slot. Inserts choose the fuel slot for
known fuel items, otherwise the input slot. The output slot is never an insert target.

### Collector (World Ingress)

The **Collector** is a world-ingress block that vacuums item entities into a buffer
and then outputs items to inventories or the prism network. **It is not a prism.**

Core behavior:

* **Intake**: scans nearby item entities (radius-limited, budgeted).
* **Flux cost**: 1 flux per 1 item vacuumed.
  * If charge is insufficient, intake fails (no partial drain).
  * No charge = no suction.
* **Charging**: sneak-right-click with a flux item to add charge (uses flux value table).
* **Buffer**: internal, finite capacity (9 slots / stack-based).
  * Buffer full → suction pauses (no item destruction, no jittery partial pulls).
* **Redstone disable**: a redstone signal forces the Collector unpowered and pauses intake/output (ready reason `REDSTONE_DISABLED`).
* **Filters**: right-click with an item toggles it in the filter list.
  * **Empty filter list = accepts all** (`EMPTY_ACCEPTS_ALL`).
* **Output order**: `INVENTORY_FIRST`.
  1. Adjacent inventories (direct insert, adapter rules respected).
  2. Prism network via beam-range connect.
* **Network output (beam-range connect)**:
  * Collector finds a nearby prism within range (max beam length) along a straight,
    unobstructed line; beams/lenses must align with the line.
  * No adjacency required.
  * Collector does **not** route; items enter the normal prism pipeline via the anchor.

Persistence:

* buffer contents
* filter list
* stored charge
* anchor prism key (cached; revalidated)
* lifetime counters + fail counts

**Insight panel (Collector)**:

1) **Identity**
   * Block: Collector
   * Key (dimension + coords)
2) **Power**
   * Charge: X / Max
   * Cost rule: 1 flux per 1 item vacuumed
   * Ready to vacuum: YES/NO + reason
3) **Filters**
   * Filter mode (EMPTY_ACCEPTS_ALL)
   * Filter count
   * Bounded filter list (+N more)
4) **Buffer**
   * Slots used / capacity
   * Top buffered stacks (bounded)
5) **Output / Connectivity**
   * Adjacent inventory targets (count + first type)
   * Network anchor status (CONNECTED / NONE / INVALID)
   * Anchor key (if connected)
   * Output mode (INVENTORY_FIRST)
6) **Counters**
   * Lifetime vacuumed items
   * Lifetime inserted to inventory
   * Lifetime handed to network
   * Fail counts by reason

Implementation note:

* Internal block id is `chaos:collector`.

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
  * the orb visual should **despawn immediately** (no lingering travel FX).
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
* Export intents may be queued ahead of time, but **actual extraction is gated by per-prism cooldown** and budgets.
* Planned export **count is based on the prism block tier** (T1..T5), not XP history.
* Enhanced Insight: candidates scanned, selected, throttled, top reasons.

### Phase 4 — Destination Resolve (Exclusive)

For each export intent, resolve **exactly one** outcome:

1. **Attuned** — bounded attempt at viable filtered destinations.
2. **Crucible** — if attuned fails and crucibles exist.
3. **Drift** — choose a viable drift sink among drift-eligible prisms with capacity.
4. **None** — if no viable destination exists, **do not queue** a departure (items stay put).

Output: **departure intent** (mode + destination/path intent) or no-op.

Enhanced Insight: attuned hits/misses, crucible usage, drift sink selection, viability failure reasons, none/no-op counts.

### Phase 5 — Movement / Simulation

* Advance orbs along edges using edge length + speed.
* Emit Arrival events when endpoints are reached.

Enhanced Insight: inflight count, avg speed, blocked/walking count, stuck flags.

### Phase 6 — Arrival (Resolution)

Runs when an orb is considered to be *at* a prism:

* true arrivals from Movement
* **spawn-at-source arrivals** for newly exported items

Responsibilities:

* orb hop increment
* apply speed ramps / prism boosts
* drift reroute checks
* settlement viability checks (may enqueue Inventory Mutations)
* award prism XP **if not already awarded for this prism visit** (guarded)
* Drift items only settle when they reach their **chosen drift sink** (destination prism).

Guard:

* if `orb.lastHandledPrismKey !== thisPrismKey` then award XP and set it.

Enhanced Insight: arrivals, spawn-arrivals, hop totals, reroutes, settle attempts/fails.

### Phase 7 — Departure (Resolution)

* Choose next hop:

  * attuned: follow or recompute route
  * drift: head toward drift sink
  * walking: round-robin cursor wandering
* Verify edge exists; reroute if missing (bounded).
* Award XP only if not already awarded for this prism visit (same guard).
* Enqueue movement along chosen edge.

Enhanced Insight: departures, reroutes, missing-edge events, cursor position.

### Phase 8 — Inventory Mutations (Budgeted, authoritative truth)

The **only phase** allowed to mutate containers.

* Execute queued extracts/inserts under budgets.
* **Extraction happens here (spawn moment).** Items are removed from the source inventory when an orb is created.
* **Insertion only happens after Arrival** when the orb reaches its destination prism.
* All “pre-checks” can be wrong; this phase is the final authority.

Enhanced Insight: queue depth, ops/sec, failures by type (full/invalid/locked), budget usage, precheck-failed rate.

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

### Transposer (formerly Teleporter)

* purpose: linked pair that relocates entities/items between two endpoints
* linking: 1â†”1 pairing via the Transposer Tuner (existing linking flow retained)
  * prevent self-link
  * link state persists across reloads
* power model (Flux):
  * internal shared charge buffer (charging either end powers both)
  * overcharge enabled (buffer may exceed the normal max)
  * if charge is insufficient for a player/NPC teleport, the teleport fails with clear FX + sound; no partial drain
  * charging: dropping flux items onto a Transposer adds charge (flux tier = charge value)
  * default buffer: 16 max, 64 overcharge cap
* costs:
  * player/NPC teleport: 1 flux
  * item entity teleport: 0 flux
* cooldown / anti-ping-pong:
  * per-entity cooldown tag after teleport
  * short duration (10â€“20 ticks) to prevent immediate bounce-back
* explicit non-scope:
  * logistics orbs / items-in-flight are **not** teleported
* Insight panel (Transposer):
  * identity: block name, this-end key, linked-end key (or Unlinked)
  * link status: UNLINKED / LINKED / LINKED_MISSING / LINKED_UNLOADED
  * distance (informational only)
  * power: shared charge X / Max, overcharge enabled
  * cost rules (player/NPC = 1 flux, item = 0)
  * ready YES/NO with reason code (NO_LINK, NO_CHARGE, COOLDOWN, DEST_INVALID)
  * cooldown remaining + last teleport ticks ago
  * counters: lifetime teleports (players, entities, items) + failed attempts by reason
* implementation note: internal IDs remain `chaos:teleporter` and `chaos:teleporter_tuner` for compatibility; player-facing text uses "Transposer"

### Crucible

* overflow sink for any item
* converts items → flux
* pressure valve to prevent deadlock
* conversion uses **flux value table** (EMC-style):
  * every vanilla item + every Chaos item has a flux value
  * values live in a dedicated data table (by item id)
  * conversion is deterministic and inspectable
  * fallback rule if an item is missing from the table (define a safe default)
  * implementation note: values are initialized from the item registry with a default,
    then overridden by explicit item entries
  * full list is generated into a data file for inspection/editing
  * **Insight**: targeting a crucible with Insight enabled reveals the default flux value, the configured lens bonus curve (`+X% per lens, capped at Y%`), and a summary of adjacent beam/lens connections so you can confirm the edge metadata matches the intended conversion boost.

  ### Network Prestige (Crystallizer-driven)

* applies to **all connected prisms** in the component triggered from
* spread over time (budgeted)
* triggering prism runs a **prestige queue**:

  * emits flux into the network over time
  * decrements stored XP/levels until baseline
* crystallizer absorbs prestige flux to grow the **Chaos Crystal**

### Lens

* beam modifier (edge metadata)
* player-placeable block
* glass placed into a beam segment **converts to a lens** (color is derived from glass color)
* has front/back faces; beams and orbs only pass through front/back (no side attachments)
* color = effect
* side texture varies by lens color; front/back textures are shared across all colors
* **lens color variants** (placeholder design):
  * white: regen
  * orange: fire resistance
  * magenta: levitation (short)
  * light_blue: slow falling
  * yellow: haste
  * lime: speed
  * pink: health boost
  * gray: resistance
  * light_gray: night vision
  * cyan: water breathing
  * purple: jump boost
  * blue: conduit power
  * brown: strength
  * green: poison (short)
  * red: weakness
  * black: blindness (short)
  * lens blocks may be placed directly or formed by a glass block replacing a beam segment that aligns with the beam axis; the conversion respects the beam axis and neighbor prisms so the final block is always treated as a proper lens and is safe to replace later.
  * **beam aura**: entities standing inside a chaos beam (not on the lens block) receive the lens effect; the aura is only active while the entity remains in the beam segment.
    * effect strength/duration scales with lens count on that edge
    * budgeted scan, no infinite re-apply spam
  * **foundry/crucible interaction** (optional, color-driven):
    * lenses can modify conversion efficiency, bonus output chance, or craft speed
    * keep lens influence **bounded** and inspectable (Insight counters)
  * **Insight**: the new lens insight provider surfaces the current color/effect, aura configuration (duration, radius, amplifier), speed/FX bonuses, and the status of the adjacent front/back connections so you can confirm a beam is routed correctly before committing items to it.

### Foundry

* consumes flux + beam state
* uses the network itself as a crafting machine
* outputs are dropped as items
* **crafting filter list**:
  * right-click foundry with an item to toggle it in the filter list
  * items are crafted in **round-robin order** across the filter list
  * if list is empty, foundry is idle
* **flux cost**:
  * crafting requires total flux value for the target item
  * foundry stores incoming flux as a buffer and spends it per craft
  * insufficient flux → wait (no partial craft)
  * **direct craft**:
    * right-click with an item acts as a “request” for that item (adds/removes filter)
    * foundry uses crucible flux values as the cost reference
  * **Insight**: the foundry insight provider reports the buffer flux stored, the number of filters, the next target in the round-robin cursor, and the lens bonus curve so you can tell whether the unit is waiting on flux, waiting on filters, or ready to craft and drop the next item.

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
* Only Phase 8 mutates inventories.
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

