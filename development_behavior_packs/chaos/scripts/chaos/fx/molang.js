// scripts/chaos/molang.js
import { MolangVariableMap } from "@minecraft/server";

// Returns a MolangVariableMap that matches transfer_orb.json:
// variable.chaos_move.direction_x/y/z and variable.chaos_move.speed
export function makeTransferMolang(dir) {
  const m = new MolangVariableMap();

  // This creates:
  // variable.chaos_move.speed
  // variable.chaos_move.direction_x
  // variable.chaos_move.direction_y
  // variable.chaos_move.direction_z
  //
  // Tune speed to taste; start obvious so you can SEE it move.
  m.setSpeedAndDirection("variable.chaos_move", 3.0, dir);
  m.setFloat("variable.chaos_lifetime", 1.0);

  return m;
}
