package service

import (
	"context"
	"encoding/json"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// ReconcileInterruptedTurns closes turns a previous daemon left running
// (plan §8.2): each open item gets its final event from what was stored,
// the turn completes as failed, and the conversation shows the failure.
// Nothing is re-sent to the provider. It returns the number of turns closed.
func ReconcileInterruptedTurns(ctx context.Context, s *store.Store, committer Committer, now time.Time) (int, error) {
	turns, err := s.RunningTurns(ctx)
	if err != nil {
		return 0, err
	}
	for i, turn := range turns {
		events, err := s.TurnEvents(ctx, turn.ConversationID, turn.ID)
		if err != nil {
			return i, err
		}
		batch := store.Batch{ConversationID: turn.ConversationID}
		for _, final := range finalsForOpenItems(events) {
			payload, _ := json.Marshal(final.payload)
			batch.Events = append(batch.Events, store.NewEvent{TurnID: turn.ID, ItemID: final.itemID, Type: "item.completed", Final: true, Payload: payload, CreatedAt: now})
		}
		pending, err := s.PendingTurnInteractions(ctx, turn.ConversationID, turn.ID)
		if err != nil {
			return i, err
		}
		for _, in := range pending {
			payload, _ := json.Marshal(map[string]any{"interaction_id": in.ID, "status": "cancelled"})
			batch.Resolutions = append(batch.Resolutions, store.InteractionResolution{ID: in.ID, Status: "cancelled", At: now, IgnoreClosed: true})
			batch.Events = append(batch.Events, store.NewEvent{TurnID: turn.ID, Type: "interaction.resolved", Final: true, Payload: payload, CreatedAt: now})
		}
		const message = "Multica restarted while this turn was running; it was not resumed"
		completed, _ := json.Marshal(map[string]any{"status": "failed", "error": map[string]any{"kind": "daemon_restarted", "message": message}})
		batch.Events = append(batch.Events, store.NewEvent{TurnID: turn.ID, Type: "turn.completed", Final: true, Payload: completed, CreatedAt: now})
		batch.CompleteTurn = &store.TurnCompletion{TurnID: turn.ID, Status: "failed", ErrorKind: "daemon_restarted", Error: message, CompletedAt: now}
		failed := "failed"
		batch.Summary = &store.SummaryPatch{Status: &failed, UpdatedAt: now}
		if _, err := committer.Submit(ctx, batch); err != nil {
			return i, err
		}
	}
	return len(turns), nil
}

type synthesizedFinal struct {
	itemID  string
	payload map[string]any
}

// finalsForOpenItems builds a failed final event for every item that
// started or streamed but has no final event, keeping the streamed text.
func finalsForOpenItems(events []sqlitedb.Event) []synthesizedFinal {
	type open struct {
		start map[string]any
		text  string
	}
	items := map[string]*open{}
	var order []string
	for _, e := range events {
		if !e.ItemID.Valid {
			continue
		}
		id := e.ItemID.String
		if e.Final == 1 {
			delete(items, id)
			continue
		}
		var payload map[string]any
		_ = json.Unmarshal([]byte(e.Payload), &payload)
		item := items[id]
		if item == nil {
			item = &open{}
			items[id] = item
			order = append(order, id)
		}
		switch e.Type {
		case "item.started":
			item.start = payload
		case "item.delta":
			if text, _ := payload["text"].(string); payload["field"] == "text" {
				item.text += text
			}
			if item.start == nil {
				item.start = map[string]any{"kind": payload["kind"]}
			}
		case "item.updated":
			item.start = payload
		}
	}
	var finals []synthesizedFinal
	for _, id := range order {
		item := items[id]
		if item == nil || item.start == nil {
			continue
		}
		state := map[string]any{}
		for k, v := range item.start {
			state[k] = v
		}
		state["status"] = "failed"
		switch state["kind"] {
		case "assistant_text", "reasoning":
			state["text"] = item.text
		case "command":
			if _, ok := state["output"]; !ok {
				state["output"] = ""
			}
			if _, ok := state["exit_code"]; !ok {
				state["exit_code"] = nil
			}
		case "file_change":
			if _, ok := state["changes"]; !ok {
				state["changes"] = []any{}
			}
		case "tool_call":
			if _, ok := state["output"]; !ok {
				state["output"] = ""
			}
		}
		finals = append(finals, synthesizedFinal{itemID: id, payload: state})
	}
	return finals
}
