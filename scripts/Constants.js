export const BlockIds = {
  ChaosCrystal: "chaos:chaos_crystal",
  ChaosInputNode: "chaos:chaos_input_node",
  ChaosOutputNode: "chaos:chaos_output_node",
};

export const DynamicPropertyIds = {
  BoundCrystal: "chaos:bound_crystal",
  AttachedFace: "chaos:attached_face",
  InputCursor: "chaos:input_cursor",
  OutputCursor: "chaos:output_cursor",
  WorldCrystalList: "chaos:crystal_list",
  CrystalInputs: "chaos:crystal_inputs",
  CrystalOutputs: "chaos:crystal_outputs",
};

export const DefaultBudgets = {
  TransfersPerTick: 4,
  InputChecksPerTick: 16,
  OutputsTriedPerInput: 6,
  ItemsPerTransfer: 1,
};

export const CrystalBindRadius = 24;

export const FaceIndex = {
  Down: 0,
  Up: 1,
  North: 2,
  South: 3,
  West: 4,
  East: 5,
};

export const FaceOffsets = {
  [FaceIndex.Down]: { x: 0, y: -1, z: 0 },
  [FaceIndex.Up]: { x: 0, y: 1, z: 0 },
  [FaceIndex.North]: { x: 0, y: 0, z: -1 },
  [FaceIndex.South]: { x: 0, y: 0, z: 1 },
  [FaceIndex.West]: { x: -1, y: 0, z: 0 },
  [FaceIndex.East]: { x: 1, y: 0, z: 0 },
};

export const OppositeFace = {
  [FaceIndex.Down]: FaceIndex.Up,
  [FaceIndex.Up]: FaceIndex.Down,
  [FaceIndex.North]: FaceIndex.South,
  [FaceIndex.South]: FaceIndex.North,
  [FaceIndex.West]: FaceIndex.East,
  [FaceIndex.East]: FaceIndex.West,
};
