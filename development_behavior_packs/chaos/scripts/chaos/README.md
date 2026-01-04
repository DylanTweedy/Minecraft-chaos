# Chaos Scripts

This folder is organized by responsibility to keep imports simple and avoid
startup side effects. The entry point is `scripts/main.js`, which delegates to
`chaos/bootstrap/index.js`.

## Folders

- `bootstrap/`
  - Startup wiring only: registers components, starts systems, and starts loops.
  - Avoid feature logic here; call into feature modules instead.

- `core/`
  - Shared core utilities and constants.
  - Should be safe to import anywhere (no import-time world access).

- `features/links/`
  - The link system: wand, pairs, transfer, beamSim, keys, etc.

- `fx/`
  - Visual/sound effects and presets.
  - No import-time world access; safe to call from systems and features.

- `systems/`
  - Background systems (e.g., link vision, cleanup-on-break).

## Import boundaries (guidelines)

- `bootstrap/` can import anything else.
- `systems/` should import from `features/*`, `core/`, and `fx/`.
- `features/*` can import `core/` and `fx/`, but should not import `bootstrap/`.
- `core/` should not import from other folders.

These are conventions (not enforced by tooling) to avoid circular imports and
keep startup behavior predictable.
