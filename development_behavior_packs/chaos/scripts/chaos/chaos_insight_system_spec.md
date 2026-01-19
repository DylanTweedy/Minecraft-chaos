# Chaos Insight System — Spec & Usage

## Purpose
Insight is a **context-driven HUD + chat overlay** that explains *what you’re looking at or interacting with*.

- **Regular Insight**: player-friendly, minimal, useful.
- **Enhanced Insight**: developer/technical view; deeper detail, reasons, diagnostics.

**Hard rule:** *No global debug.* Insight should not show “system-wide” info without context. Context is established by looking at or interacting with a **block, item, or entity**.

## Design Goals
1. **Context-first**: only show info when there is a clear focus target.
2. **Player-friendly by default**: Regular Insight should help normal players.
3. **Enhanced for deep diagnostics**: Extra detail only when explicitly requested.
4. **Extensible**: easy to add support for new custom blocks/items/entities.
5. **Eventually universal**: extend to *vanilla* blocks/items/entities as well.
6. **Low-noise**: avoid spam, dedupe, and rate-limit chat output.

## Player Experience
### Activation / Deactivation
- When Insight becomes active, show **one-time feedback**:
  - Title/Toast: `Insight On`
- When Insight becomes inactive, show **one-time feedback**:
  - Title/Toast: `Insight Off`

**Important:** Do **not** show “Insight On” as a persistent fallback in the HUD.

### HUD (Actionbar)
- Actionbar updates **only while the player has a focus target** (block/item/entity).
- If no focus target is found, actionbar should be **empty** (or optionally a very subtle blank/clear).

### Chat Output
- Chat output is used for:
  - short contextual tips
  - important warnings
  - explicit “details dumps” in Enhanced mode
- Chat must be **rate-limited** and **deduped**.

## Modes
### Mode 0 — Off
- No actionbar updates.
- No provider evaluation.

### Mode 1 — Regular Insight
- **Actionbar**: short, friendly description of focused target.
- **Chat**: only when it adds value (e.g., interaction feedback, critical warnings), and not spammy.

### Mode 2 — Enhanced Insight
Enhanced mode is for developers / technical players.

- Triggered by an explicit action (example patterns):
  - Sneak while Insight is active *(current behavior)*
  - Or: right-click with insight lens *(optional future)*
- **Actionbar** still remains concise.
- **Chat dump** includes:
  - structured diagnostics
  - reason codes (why blocked / why no path / why no export)
  - recent trace lines scoped to the focused target

**Still context-driven:** enhanced output only appears when a focus target exists.

## Context Model
Insight always renders against a single **Context Target**:

- `BlockTarget` (a block the player is looking at)
- `ItemTarget` (the item in hand / selected item)
- `EntityTarget` (entity in crosshair)

### Context Acquisition Priority
Recommended order:
1. **Block in view** (crosshair hit)
2. **Entity in view** (crosshair hit)
3. **Held item** (mainhand)

This ensures “looking at the world” wins over “I happen to be holding a thing”.

### Context Key
Every target maps to a stable `contextKey` string.

- Block: `block:<dimension>:<x>,<y>,<z>`
- Entity: `entity:<dimension>:<entityId>`
- Item: `item:<itemId>`

This key is used to:
- store scoped messages (trace)
- store scoped stats (per prism / per machine)
- dedupe and rate-limit per-target chat

## Provider System
Providers are pluggable handlers that know how to describe a target.

### Provider Contract
A provider receives `(player, target, mode)` and returns:
- `hudLine?: string` (actionbar text)
- `chatLines?: string[]` (enhanced and/or occasional regular output)
- `severity?: 'info'|'warn'|'error'` (optional; may influence styling)
- `contextKey: string` (required)
- `tags?: string[]` (optional; for filtering / future UX)

### Provider Selection
- Providers are registered with matchers:
  - Block id matcher (`chaos:prism_*`)
  - Item id matcher (`minecraft:clock`, `chaos:wand`)
  - Entity id matcher (`chaos:beam_entity`)
- First match wins, with an explicit priority system.

### Fallback Provider
Fallback should **not** emit “Insight On” continuously.

Instead:
- Fallback returns **no hudLine** unless it has a meaningful message.
- Optionally it can return a *single* gentle tip in chat occasionally (rate-limited):
  - e.g., “Look at a block or hold an item to inspect.”

## Trace & Diagnostics
Trace is the mechanism other systems use to report info.

### Types of Trace
- **Scoped trace** (preferred): stored under `contextKey`.
- **Player-local trace**: stored for that player.
- **Global trace**: allowed only for *rare, critical* messages, but should still be deliverable through a context view (e.g., shown when looking at any prism). Avoid in general.

### Enhanced Dumps
Enhanced mode should pull:
1. Provider `chatLines`
2. Recent scoped trace lines for `contextKey`
3. Scoped structured stats snapshot (if available)
4. Optional: a small “network summary” ONLY if it is *directly relevant to the focused target* (e.g., for prisms, show network inflight/queue counts). Never show unrelated systems.

## Vanilla Support Roadmap
Insight should be able to describe vanilla targets.

### Suggested Phases
1. **Vanilla Items**: clock/compass/map-style informational items.
2. **Vanilla Blocks**: containers, furnace-like blocks, redstone components.
3. **Vanilla Entities**: mobs with basic identity/health/status.

Vanilla support should use the same provider system.

## UX Rules (Anti-Spam)
- **Actionbar rate**: update only when target changes or at a modest Hz while locked on.
- **Chat rate**: per player + per contextKey cooldown.
- **Dedupe**: identical lines within a window should not reprint.
- **Severity routing**:
  - Regular mode: show only actionable warnings/errors.
  - Enhanced mode: show full diagnostics.

## Examples
### Prism (Regular)
HUD: `Prism T2 • Q3 • Blocked (NoInv)`

### Prism (Enhanced)
Chat:
- `Export: none (all destinations full)`
- `Path: no candidate prisms (all attuned)`
- `Last scan: 12 invs, 0 acceptors`
- `Recent:`
  - `blocked(noInv)`
  - `blocked(destFull)`

### Generic Block (Vanilla Example)
HUD: `Chest • 12/27 slots used`
Enhanced:
- lists top 3 item types
- hints if full

## Implementation Notes (Alignment Targets)
To bring code into alignment:
1. Router should only render actionbar when a focus target exists.
2. Remove persistent “Insight On” fallback HUD output.
3. Ensure enhanced dump includes provider chatLines + scoped trace.
4. Introduce a clean `contextKey` standard used everywhere.
5. Push trace emission towards scoped contexts (block/entity/item).
6. Keep any “network summary” gated behind relevant contexts (e.g., only when inspecting prisms).

