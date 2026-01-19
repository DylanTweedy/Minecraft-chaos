// scripts/chaos/core/insight/state.js

const _states = new Map(); // playerId -> state

function createState(playerId) {
  return {
    playerId,
    insightActive: false,
    enhanced: false,
    lastInsightActive: false,
    lastEnhanced: false,
    held: null,
    target: null,
    lastActionbarText: "",
    lastChatHash: "",
    chatQueue: [],
    provider: {
      id: null,
      contextKey: null,
      contextLabel: "",
      chatLines: [],
      includeNetworkSummary: false,
    },
    lastProviderContextKey: null,
    enhancedLastDumpTickByKey: new Map(),
  };
}

export function getInsightState(player) {
  if (!player?.id) return null;
  const pid = player.id;
  let state = _states.get(pid);
  if (!state) {
    state = createState(pid);
    _states.set(pid, state);
  }
  return state;
}

export function removeInsightState(playerId) {
  if (!playerId) return;
  _states.delete(playerId);
}

export function getAllInsightStates() {
  return _states;
}

export function isInsightActive(player) {
  const state = getInsightState(player);
  return !!state?.insightActive;
}

export function isInsightEnhanced(player) {
  const state = getInsightState(player);
  return !!state?.enhanced;
}
