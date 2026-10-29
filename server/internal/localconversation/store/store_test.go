package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

var testTime = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "conversations.sqlite")
	s, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

func createConversation(t *testing.T, s *Store, id string) int64 {
	t.Helper()
	ctx := context.Background()
	scopeID, err := s.EnsureScope(ctx, Scope{APIOrigin: "https://api.multica.ai", UserID: "user-1", WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatalf("EnsureScope: %v", err)
	}
	if _, err := s.CreateConversation(ctx, NewConversation{ID: id, ScopeID: scopeID, Provider: "claude", Title: id, Cwd: "/repo", CreatedAt: testTime}); err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	return scopeID
}

func event(turnID, itemID, typ string, final bool, payload string) NewEvent {
	return NewEvent{TurnID: turnID, ItemID: itemID, Type: typ, Final: final, Payload: json.RawMessage(payload), CreatedAt: testTime}
}

func TestOpenAppliesDurabilityPragmasAndPrivateMode(t *testing.T) {
	t.Parallel()

	s, path := openTestStore(t)
	for name, want := range map[string]string{"journal_mode": "wal", "synchronous": "2", "fullfsync": "1", "checkpoint_fullfsync": "1"} {
		var got string
		if err := s.write.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("PRAGMA %s = %s, want %s", name, got, want)
		}
	}
	var readOnly int
	if err := s.read.QueryRow("PRAGMA query_only").Scan(&readOnly); err != nil || readOnly != 1 {
		t.Fatalf("read pool query_only = %d, %v", readOnly, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("database mode = %v, want 0600", mode)
	}
}

func TestReopenKeepsGenerationAndSchema(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "conversations.sqlite")
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	generation := first.Generation()
	if generation == "" {
		t.Fatal("empty generation")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()
	if second.Generation() != generation {
		t.Fatalf("generation changed: %s -> %s", generation, second.Generation())
	}
}

func TestOpenRejectsNewerSchema(t *testing.T) {
	t.Parallel()

	s, path := openTestStore(t)
	if _, err := s.write.Exec("PRAGMA user_version = 99"); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	_, err := Open(context.Background(), path)
	if !errors.Is(err, ErrUnsupportedSchema) {
		t.Fatalf("Open = %v, want ErrUnsupportedSchema", err)
	}
}

func TestSubmitAssignsConversationAndTurnSequences(t *testing.T) {
	t.Parallel()

	s, path := openTestStore(t)
	createConversation(t, s, "conv-1")
	w := s.NewWriter(WriterOptions{})
	ctx := context.Background()

	got, err := w.Submit(ctx, Batch{
		ConversationID: "conv-1",
		StartTurn:      &NewTurn{ID: "turn-1", RequestID: "req-1", StartedAt: testTime},
		Events: []NewEvent{
			event("turn-1", "", "user.message", true, `{"message_id":"m1","content":"hi"}`),
			event("turn-1", "", "turn.started", false, `{"request_id":"req-1"}`),
			event("", "", "conversation.updated", false, `{"title":"hi"}`),
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	wantSeq := []int64{1, 2, 3}
	wantTurnSeq := []int64{1, 2, 0}
	for i, e := range got.Events {
		if e.Seq != wantSeq[i] || e.TurnSeq != wantTurnSeq[i] {
			t.Fatalf("event %d seq=%d turn_seq=%d, want %d/%d", i, e.Seq, e.TurnSeq, wantSeq[i], wantTurnSeq[i])
		}
	}
	w.Close()
	_ = s.Close()

	// Sequences continue after a restart instead of starting from zero.
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	w2 := reopened.NewWriter(WriterOptions{})
	defer w2.Close()
	got, err = w2.Submit(ctx, Batch{ConversationID: "conv-1", Events: []NewEvent{event("turn-1", "it-1", "item.delta", false, `{"kind":"assistant_text","field":"text","text":"a"}`)}})
	if err != nil {
		t.Fatal(err)
	}
	if e := got.Events[0]; e.Seq != 4 || e.TurnSeq != 3 {
		t.Fatalf("after reopen seq=%d turn_seq=%d, want 4/3", e.Seq, e.TurnSeq)
	}
}

func TestSubmitRejectsOnlyTheInvalidBatchInAGroup(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	createConversation(t, s, "conv-1")
	createConversation(t, s, "conv-2")
	// A large group size and concurrent submissions make the writer merge
	// batches; correctness must not depend on whether they actually merge.
	w := s.NewWriter(WriterOptions{MaxGroup: 64})
	defer w.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make([]error, 3)
	batches := []Batch{
		{ConversationID: "conv-1", Events: []NewEvent{event("", "", "queue.updated", false, `{"revision":1,"paused":false,"count":0}`)}},
		{ConversationID: "missing", Events: []NewEvent{event("", "", "queue.updated", false, `{}`)}},
		{ConversationID: "conv-2", Events: []NewEvent{event("turn-x", "", "turn.started", false, `{}`)}},
	}
	for i, b := range batches {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = w.Submit(ctx, b)
		}()
	}
	wg.Wait()
	if errs[0] != nil {
		t.Fatalf("valid batch failed: %v", errs[0])
	}
	if !errors.Is(errs[1], ErrNotFound) || !errors.Is(errs[2], ErrNotFound) {
		t.Fatalf("invalid batches = %v, %v; want ErrNotFound", errs[1], errs[2])
	}
	events, err := s.EventsAfter(ctx, "conv-2", 0, 100, 10)
	if err != nil || len(events) != 0 {
		t.Fatalf("rejected batch left events: %v, %v", events, err)
	}
	events, err = s.EventsAfter(ctx, "conv-1", 0, 100, 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("valid batch events = %v, %v", events, err)
	}
}

func TestSubmitRejectsInvalidPayload(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	createConversation(t, s, "conv-1")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	_, err := w.Submit(context.Background(), Batch{ConversationID: "conv-1", Events: []NewEvent{event("", "", "queue.updated", false, `{`)}})
	if err == nil {
		t.Fatal("invalid JSON payload accepted")
	}
}

func TestSummaryPatchAdvancesScopeStream(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	scopeID := createConversation(t, s, "conv-1")
	createConversation(t, s, "conv-2")
	ctx := context.Background()
	_, before, err := s.SummariesAfter(ctx, scopeID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}

	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	running := "running"
	preview := "测试全部通过。"
	got, err := w.Submit(ctx, Batch{ConversationID: "conv-1", Summary: &SummaryPatch{Status: &running, LastMessagePreview: &preview, UpdatedAt: testTime.Add(time.Minute)}})
	if err != nil {
		t.Fatal(err)
	}
	if got.ScopeSeq != before+1 || got.Summary == nil || got.Summary.Status != "running" {
		t.Fatalf("committed = %+v, want scope seq %d with running summary", got, before+1)
	}

	rows, scopeSeq, err := s.SummariesAfter(ctx, scopeID, before, 10)
	if err != nil {
		t.Fatal(err)
	}
	if scopeSeq != got.ScopeSeq || len(rows) != 1 || rows[0].ID != "conv-1" || rows[0].LastMessagePreview != preview {
		t.Fatalf("summaries after %d = %+v (scope seq %d)", before, rows, scopeSeq)
	}
}

func TestSnapshotUsesFinalEventsForFinishedItems(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	createConversation(t, s, "conv-1")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	submit := func(b Batch) {
		t.Helper()
		if _, err := w.Submit(ctx, b); err != nil {
			t.Fatal(err)
		}
	}

	// A finished turn: only its final events are returned.
	submit(Batch{ConversationID: "conv-1", StartTurn: &NewTurn{ID: "turn-1", StartedAt: testTime}, Events: []NewEvent{
		event("turn-1", "it-1", "item.delta", false, `{"text":"a"}`),
		event("turn-1", "it-1", "item.completed", true, `{"text":"ab"}`),
		event("turn-1", "", "turn.completed", true, `{"status":"completed"}`),
	}, Messages: []NewMessage{{ID: "m1", TurnID: "turn-1", Role: "assistant", Content: "ab", CreatedAt: testTime}},
		CompleteTurn: &TurnCompletion{TurnID: "turn-1", Status: "completed", CompletedAt: testTime}})
	// A running turn: it-2 is finished, it-3 is still streaming.
	submit(Batch{ConversationID: "conv-1", StartTurn: &NewTurn{ID: "turn-2", StartedAt: testTime}, Events: []NewEvent{
		event("turn-2", "", "turn.started", false, `{}`),
		event("turn-2", "it-2", "item.delta", false, `{"text":"x"}`),
		event("turn-2", "it-2", "item.completed", true, `{"text":"x"}`),
		event("turn-2", "it-3", "item.delta", false, `{"text":"y"}`),
	}})

	snap, err := s.Snapshot(ctx, "conv-1", 20)
	if err != nil {
		t.Fatal(err)
	}
	if snap.SnapshotSeq != 7 || len(snap.Turns) != 2 || snap.HasOlderTurns {
		t.Fatalf("snapshot seq=%d turns=%d older=%v", snap.SnapshotSeq, len(snap.Turns), snap.HasOlderTurns)
	}
	if got := eventSeqs(snap.Turns[0]); fmt.Sprint(got) != "[2 3]" {
		t.Fatalf("finished turn events = %v, want final events [2 3]", got)
	}
	if len(snap.Turns[0].Messages) != 1 {
		t.Fatalf("finished turn messages = %d", len(snap.Turns[0].Messages))
	}
	if got := eventSeqs(snap.Turns[1]); fmt.Sprint(got) != "[4 6 7]" {
		t.Fatalf("running turn events = %v, want turn.started, it-2 final, it-3 delta [4 6 7]", got)
	}

	page, err := s.Snapshot(ctx, "conv-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Turns) != 1 || page.Turns[0].Turn.ID != "turn-2" || !page.HasOlderTurns {
		t.Fatalf("limited snapshot = %d turns, older=%v", len(page.Turns), page.HasOlderTurns)
	}
	older, err := s.TurnsBefore(ctx, "conv-1", page.Turns[0].Turn.TurnIndex, 10)
	if err != nil || len(older) != 1 || older[0].Turn.ID != "turn-1" {
		t.Fatalf("TurnsBefore = %v, %v", older, err)
	}
}

func TestEventsAfterReturnsEveryEventInRange(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	createConversation(t, s, "conv-1")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	var events []NewEvent
	for i := range 5 {
		events = append(events, event("", "it", "item.delta", i == 4, `{}`))
	}
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv-1", Events: events}); err != nil {
		t.Fatal(err)
	}

	got, err := s.EventsAfter(ctx, "conv-1", 1, 4, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Seq != 2 || got[2].Seq != 4 {
		t.Fatalf("EventsAfter(1, 4) = %d events from %d", len(got), got[0].Seq)
	}
	limited, err := s.EventsAfter(ctx, "conv-1", 0, 5, 2)
	if err != nil || len(limited) != 2 {
		t.Fatalf("limit not applied: %d, %v", len(limited), err)
	}
}

func TestRunningTurnsListsUnfinishedTurns(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	createConversation(t, s, "conv-1")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv-1", StartTurn: &NewTurn{ID: "turn-1", StartedAt: testTime}}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv-1", StartTurn: &NewTurn{ID: "turn-2", StartedAt: testTime},
		CompleteTurn: &TurnCompletion{TurnID: "turn-2", Status: "cancelled", CompletedAt: testTime}}); err != nil {
		t.Fatal(err)
	}
	running, err := s.RunningTurns(ctx)
	if err != nil || len(running) != 1 || running[0].ID != "turn-1" {
		t.Fatalf("RunningTurns = %+v, %v", running, err)
	}
}

func TestSubmitAfterCloseFails(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	w := s.NewWriter(WriterOptions{})
	w.Close()
	if _, err := w.Submit(context.Background(), Batch{ConversationID: "x"}); !errors.Is(err, ErrWriterClosed) {
		t.Fatalf("Submit after Close = %v", err)
	}
}

func eventSeqs(v TurnView) []int64 {
	seqs := make([]int64, len(v.Events))
	for i, e := range v.Events {
		seqs[i] = e.Seq
	}
	return seqs
}
