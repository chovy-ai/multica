package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

type serviceFixture struct {
	svc      *Service
	path     string
	scopeID  int64
	mu       sync.Mutex
	adapters []*fakeAdapter
}

func newServiceFixture(t *testing.T, path string) *serviceFixture {
	t.Helper()
	f := &serviceFixture{path: path}
	svc, err := Open(context.Background(), Options{Path: path, ContextMCPName: "multica", Claude: f.launch})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close(context.Background()) })
	f.svc = svc
	f.scopeID, err = svc.Store().EnsureScope(context.Background(), store.Scope{APIOrigin: "https://api.multica.ai", UserID: "u", WorkspaceID: "w"})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *serviceFixture) launch(_ context.Context, conv sqlitedb.Conversation) (ClaudeSession, StartClaudeAdapter, error) {
	return ClaudeSession{Fields: map[string]any{"executable": "/bin/claude", "cwd": conv.Cwd}}, func(_ context.Context, h claude.Handler) (ClaudeAdapter, error) {
		a := &fakeAdapter{handler: h, done: make(chan struct{})}
		f.mu.Lock()
		f.adapters = append(f.adapters, a)
		f.mu.Unlock()
		return a, nil
	}, nil
}

func (f *serviceFixture) create(t *testing.T, id, provider string) {
	t.Helper()
	if _, err := f.svc.Store().CreateConversation(context.Background(), store.NewConversation{ID: id, ScopeID: f.scopeID, Provider: provider, Cwd: "/repo", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

func TestServiceSendIsIdempotentPerRequestID(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	ctx := context.Background()
	cmd := SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "req-1", Text: "hi"}
	first, err := f.svc.Send(ctx, cmd)
	if err != nil || first.Replayed {
		t.Fatalf("first send = %+v, %v", first, err)
	}
	again, err := f.svc.Send(ctx, cmd)
	if err != nil || !again.Replayed || again.TurnID != first.TurnID {
		t.Fatalf("retry = %+v, %v; want replay of %s", again, err, first.TurnID)
	}
	if got := f.adapters[0].sent(); fmt.Sprint(got) != "[start send]" {
		t.Fatalf("retry reached the adapter: %v", got)
	}
	cmd.Text = "different"
	if _, err := f.svc.Send(ctx, cmd); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("reused id with new content = %v", err)
	}
}

func TestServiceChecksScopeAndProvider(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	f.create(t, "conv-codex", "codex")
	ctx := context.Background()
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID + 1, ConversationID: "conv-1", RequestID: "r", Text: "x"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("send from another scope = %v", err)
	}
	if _, err := f.svc.Snapshot(ctx, f.scopeID+1, "conv-1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("snapshot from another scope = %v", err)
	}
	if _, _, err := f.svc.Subscribe(ctx, f.scopeID+1, "conv-1", 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("subscribe from another scope = %v", err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-codex", RequestID: "r", Text: "x"}); !errors.Is(err, ErrUnsupportedProvider) {
		t.Fatalf("send to codex = %v", err)
	}
}

func TestServicePublishesCommittedEventsToSubscribers(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	ctx := context.Background()
	sub, _, err := f.svc.Subscribe(ctx, f.scopeID, "conv-1", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close()
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "req-1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	f.adapters[0].emit(t, `{"type":"result","subtype":"success","is_error":false,"result":""}`)

	deadline, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var types []string
	for len(types) == 0 || types[len(types)-1] != "turn.completed" {
		events, err := sub.Next(deadline)
		if err != nil {
			t.Fatalf("Next: %v (got %v)", err, types)
		}
		for _, e := range events {
			types = append(types, e.Type)
		}
	}
	if fmt.Sprint(types) != "[user.message turn.started turn.completed]" {
		t.Fatalf("subscriber saw %v", types)
	}
}

func TestOpenClosesTurnsInterruptedByARestart(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "c.sqlite")
	ctx := context.Background()
	// A previous daemon left a running turn with a half-streamed answer, an
	// unfinished command and one finished item.
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	scopeID, _ := st.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
	if _, err := st.CreateConversation(ctx, store.NewConversation{ID: "conv-1", ScopeID: scopeID, Provider: "claude", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	w := st.NewWriter(store.WriterOptions{})
	ev := func(item, typ string, final bool, payload string) store.NewEvent {
		return store.NewEvent{TurnID: "turn-1", ItemID: item, Type: typ, Final: final, Payload: json.RawMessage(payload), CreatedAt: time.Now()}
	}
	_, err = w.Submit(ctx, store.Batch{ConversationID: "conv-1", StartTurn: &store.NewTurn{ID: "turn-1", StartedAt: time.Now()}, Events: []store.NewEvent{
		ev("m1:0", "item.started", false, `{"kind":"assistant_text"}`),
		ev("m1:0", "item.delta", false, `{"kind":"assistant_text","field":"text","text":"half "}`),
		ev("m1:0", "item.delta", false, `{"kind":"assistant_text","field":"text","text":"answer"}`),
		ev("tu-1", "item.started", false, `{"kind":"command","command":"sleep 9"}`),
		ev("tu-2", "item.started", false, `{"kind":"tool_call","tool":"Read"}`),
		ev("tu-2", "item.completed", true, `{"kind":"tool_call","status":"completed","tool":"Read","output":"ok"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	w.Close()
	_ = st.Close()

	f := newServiceFixture(t, path)
	events, err := f.svc.Store().TurnEvents(ctx, "conv-1", "turn-1")
	if err != nil {
		t.Fatal(err)
	}
	var tail []string
	for _, e := range events[6:] {
		var p map[string]any
		_ = json.Unmarshal([]byte(e.Payload), &p)
		tail = append(tail, fmt.Sprintf("%s %s %v %v", e.Type, e.ItemID.String, p["status"], p["text"]))
	}
	want := []string{"item.completed m1:0 failed half answer", "item.completed tu-1 failed <nil>", "turn.completed  failed <nil>"}
	if fmt.Sprint(tail) != fmt.Sprint(want) {
		t.Fatalf("reconciled events = %v, want %v", tail, want)
	}
	conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
	if conv.Status != "failed" {
		t.Fatalf("conversation status = %s", conv.Status)
	}
	if running, _ := f.svc.Store().RunningTurns(ctx); len(running) != 0 {
		t.Fatalf("turns still running: %+v", running)
	}
}

func TestServiceUpdateSettingsPersistsAndAppliesToTheLiveAdapter(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	ctx := context.Background()
	opus, auto := "claude-opus-5-5", "auto"
	// Before any adapter runs, only the stored settings change.
	if err := f.svc.UpdateSettings(ctx, f.scopeID, "conv-1", SettingsUpdate{Model: &opus}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	a := f.adapters[0]
	if a.fields[0]["model"] != opus {
		t.Fatalf("adapter started with %v, want model %s", a.fields[0], opus)
	}

	if err := f.svc.UpdateSettings(ctx, f.scopeID, "conv-1", SettingsUpdate{ClearModel: true, PermissionMode: &auto}); err != nil {
		t.Fatal(err)
	}
	if got := a.sent(); fmt.Sprint(got) != "[start send set_model apply_flag_settings set_permission_mode]" {
		t.Fatalf("adapter requests = %v", got)
	}
	if a.fields[2]["model"] != nil || a.fields[4]["mode"] != "auto" {
		t.Fatalf("applied fields = %v / %v", a.fields[2], a.fields[4])
	}
	conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
	if conv.Model.Valid || conv.PermissionMode != "auto" {
		t.Fatalf("stored settings = model %v permission %s", conv.Model, conv.PermissionMode)
	}

	bad := "yolo"
	if err := f.svc.UpdateSettings(ctx, f.scopeID, "conv-1", SettingsUpdate{PermissionMode: &bad}); !errors.Is(err, ErrInvalidSettings) {
		t.Fatalf("invalid permission mode = %v", err)
	}
	if err := f.svc.UpdateSettings(ctx, f.scopeID+1, "conv-1", SettingsUpdate{Model: &opus}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update from another scope = %v", err)
	}
}
