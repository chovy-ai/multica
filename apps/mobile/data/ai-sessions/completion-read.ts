import type { LocalV2Snapshot } from "@multica/core/local-conversation/v2";

/** Only an actually visible successful result in the active screen is a read. */
export function shownCompletion(snapshot: LocalV2Snapshot | undefined, visibleTurns: string[], active: boolean) {
  const completion = snapshot?.conversation.completion;
  const read = snapshot?.conversation.read_completion_seq;
  if (!active || !snapshot || !completion || read === undefined || read >= completion.completion_seq || !visibleTurns.includes(completion.turn_id)) return null;
  if (!snapshot.turns.some((turn) => turn.id === completion.turn_id && turn.turn_index === completion.turn_index && turn.status === "completed")) return null;
  return { store_generation: snapshot.store_generation, ...completion };
}
