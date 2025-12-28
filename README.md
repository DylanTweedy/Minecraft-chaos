# Chaos Logistics (Phase 1)

Wireless item transfer network for Minecraft Bedrock (Behavior Pack + Script API).

## How to use
1. Place a **Chaos Crystal** block.
2. Place **Chaos Input Node** or **Chaos Output Node** blocks on the face of any inventory block.
3. Put items into the node's filter inventory:
   - Input Node filter controls which items can be pulled.
   - Output Node filter controls which items can be inserted.
   - Empty filter means "allow all".
4. Punch or use a node to rebind to the nearest crystal if needed.
5. Watch for a brief particle beam on bind and on successful transfers.

## Getting the blocks in-game
Use the items to place blocks normally (recommended so the node records the attached face):
- `/give @s chaos:chaos_crystal 1`
- `/give @s chaos:chaos_input_node 1`
- `/give @s chaos:chaos_output_node 1`

You can also use `/setblock` with the same identifiers, but nodes placed that way may attach to
the wrong face unless you rebind or replace them by hand.

## Notes
- Only the Chaos Crystal runs per-tick logic.
- The network uses bounded sampling per tick, so large networks transfer slower but stay performant.
- No cross-dimension networks in Phase 1.
