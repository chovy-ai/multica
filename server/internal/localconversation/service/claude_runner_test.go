package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

// fakeAdapter records requests and lets the test drive adapter output.
type fakeAdapter struct {
	mu       sync.Mutex
	handler  claude.Handler
	requests []string
	fields   []map[string]any
	reply    func(typ string) (json.RawMessage, error)
	done     chan struct{}
	err      error
	closed   bool
}

func (a *fakeAdapter) Request(_ context.Context, typ string, fields map[string]any) (json.RawMessage, error) {
	a.mu.Lock()
	a.requests = append(a.requests, typ)
	a.fields = append(a.fields, fields)
	reply := a.reply
	a.mu.Unlock()
	if reply != nil {
		return reply(typ)
	}
	return json.RawMessage(`{}`), nil
}

func (a *fakeAdapter) Close(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		a.closed = true
		close(a.done)
	}
	return nil
}

func (a *fakeAdapter) Done() <-chan struct{} { return a.done }
func (a *fakeAdapter) Err() error            { return a.err }

func (a *fakeAdapter) emit(t *testing.T, messages ...string) {
	t.Helper()
	for _, m := range messages {
		a.handler(claude.Output{Type: "sdk_message", Message: json.RawMessage(m)})
	}
}

func (a *fakeAdapter) exit(err error) {
	a.mu.Lock()
	a.err = err
	a.mu.Unlock()
	_ = a.Close(context.Background())
}

func (a *fakeAdapter) sent() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.requests...)
}

type runnerFixture struct {
	scopeID  int64
	store    *store.Store
	batcher  *Batcher
	limiter  *Limiter
	runner   *ClaudeRunner
	adapters []*fakeAdapter
	mu       sync.Mutex
}

func newRunnerFixture(t *testing.T, limiter *Limiter, reply func(string) (json.RawMessage, error)) *runnerFixture {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, filepath.Join(t.TempDir(), "conversations.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	scopeID, err := s.EnsureScope(ctx, store.Scope{APIOrigin: "https://api.multica.ai", UserID: "u", WorkspaceID: "w"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(ctx, store.NewConversation{ID: "conv-1", ScopeID: scopeID, Provider: "claude", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	w := s.NewWriter(store.WriterOptions{})
	t.Cleanup(w.Close)
	f := &runnerFixture{store: s, limiter: limiter}
	f.batcher = NewBatcher(w, BatcherOptions{MaxDelay: time.Millisecond})
	t.Cleanup(f.batcher.Close)
	f.scopeID = scopeID
	f.runner = NewClaudeRunner(ClaudeRunnerOptions{
		ConversationID: "conv-1", ScopeID: scopeID, Files: s, Batcher: f.batcher, Limiter: limiter, ContextMCPName: "multica",
		Session: ClaudeSession{Fields: map[string]any{"executable": "/bin/claude", "cwd": "/repo"}, ProviderSessionID: "native-0"},
		Start: func(_ context.Context, handler claude.Handler) (ClaudeAdapter, error) {
			a := &fakeAdapter{handler: handler, reply: reply, done: make(chan struct{})}
			f.mu.Lock()
			f.adapters = append(f.adapters, a)
			f.mu.Unlock()
			return a, nil
		},
	})
	return f
}

func (f *runnerFixture) adapter(i int) *fakeAdapter {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.adapters[i]
}

// turnEvents waits until the turn has a turn.completed event and returns
// the turn's events as "type item status" lines.
func (f *runnerFixture) turnEvents(t *testing.T, turnID string) []string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		events, err := f.store.EventsAfter(context.Background(), "conv-1", 0, 1<<30, 1000)
		if err != nil {
			t.Fatal(err)
		}
		var lines []string
		completed := false
		for _, e := range events {
			if e.TurnID.String != turnID {
				continue
			}
			var p map[string]any
			_ = json.Unmarshal([]byte(e.Payload), &p)
			lines = append(lines, strings.TrimSpace(fmt.Sprintf("%s %s %v", e.Type, e.ItemID.String, p["status"])))
			completed = completed || e.Type == "turn.completed"
		}
		if completed {
			return lines
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn %s never completed; events %v", turnID, lines)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func send(t *testing.T, f *runnerFixture, turn string) {
	t.Helper()
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: turn, RequestID: "req-" + turn, MessageID: "msg-" + turn, Text: "跑一下测试"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

func TestClaudeRunnerRecordsACompletedTurn(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	send(t, f, "t1")
	a := f.adapter(0)
	if got := a.sent(); fmt.Sprint(got) != "[start send]" {
		t.Fatalf("requests = %v", got)
	}
	if a.fields[0]["resume"] != "native-0" || a.fields[0]["executable"] != "/bin/claude" {
		t.Fatalf("start fields = %v", a.fields[0])
	}
	a.emit(t,
		`{"type":"system","subtype":"init","session_id":"native-1"}`,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"通过"}}}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"测试通过。"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"测试通过。"}`,
	)
	got := f.turnEvents(t, "t1")
	want := []string{"user.message  <nil>", "turn.started  <nil>", "item.started m1:0 <nil>", "item.delta m1:0 <nil>", "item.completed m1:0 completed", "turn.completed  completed"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events:\n%v\nwant:\n%v", got, want)
	}

	snap, err := f.store.Snapshot(context.Background(), "conv-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Conversation.Status != "idle" || snap.Conversation.ProviderSessionID != "native-1" || snap.Conversation.LastMessagePreview != "测试通过。" {
		t.Fatalf("conversation = status %q session %q preview %q", snap.Conversation.Status, snap.Conversation.ProviderSessionID, snap.Conversation.LastMessagePreview)
	}
	turn := snap.Turns[len(snap.Turns)-1]
	if turn.Turn.Status != "completed" || len(turn.Messages) != 2 {
		t.Fatalf("turn = %+v, %d messages", turn.Turn, len(turn.Messages))
	}
	if f.limiter.Running() != 0 {
		t.Fatalf("limiter still holds %d turns", f.limiter.Running())
	}

	// The next turn reuses the live adapter.
	send(t, f, "t2")
	if got := a.sent(); fmt.Sprint(got) != "[start send send]" {
		t.Fatalf("requests after second send = %v", got)
	}
}

func TestClaudeRunnerFailsTheTurnWhenTheAdapterExits(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	send(t, f, "t1")
	a := f.adapter(0)
	a.emit(t,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half"}}}`,
	)
	a.exit(errors.New("adapter exited: signal: killed"))
	got := f.turnEvents(t, "t1")
	if got[len(got)-2] != "item.completed m1:0 failed" || got[len(got)-1] != "turn.completed  failed" {
		t.Fatalf("events = %v", got)
	}

	// The next send starts a new adapter that resumes the native session.
	send(t, f, "t2")
	f.mu.Lock()
	started := len(f.adapters)
	f.mu.Unlock()
	if started != 2 {
		t.Fatalf("adapters started = %d, want 2", started)
	}
}

func TestClaudeRunnerMarksInterruptedTurnsCancelled(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	send(t, f, "t1")
	if err := f.runner.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.adapter(0).emit(t, `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["interrupted"]}`)
	got := f.turnEvents(t, "t1")
	if got[len(got)-1] != "turn.completed  cancelled" {
		t.Fatalf("events = %v", got)
	}
}

func TestClaudeRunnerCancelsWhenInterruptClosesTheQuery(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), func(typ string) (json.RawMessage, error) {
		if typ == "interrupt" {
			return json.RawMessage(`{"outcome":"closed"}`), nil
		}
		return json.RawMessage(`{}`), nil
	})
	send(t, f, "t1")
	if err := f.runner.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.turnEvents(t, "t1"); got[len(got)-1] != "turn.completed  cancelled" {
		t.Fatalf("events = %v", got)
	}
}

func TestClaudeRunnerRecordsSendFailures(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), func(typ string) (json.RawMessage, error) {
		if typ == "send" {
			return nil, &claude.AdapterError{Code: "sdk_error", Message: "exited", Dispatch: "outcome_unknown"}
		}
		return json.RawMessage(`{}`), nil
	})
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t1", RequestID: "r", MessageID: "m", Text: "x"}); err == nil {
		t.Fatal("Send succeeded")
	}
	f.turnEvents(t, "t1")
	snap, err := f.store.Snapshot(context.Background(), "conv-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if turn := snap.Turns[0].Turn; turn.Status != "failed" || turn.ErrorKind != "outcome_unknown" {
		t.Fatalf("turn = %+v", turn)
	}
	if f.limiter.Running() != 0 {
		t.Fatal("limiter slot leaked")
	}
}

func TestClaudeRunnerRespectsTheConcurrencyLimitAndOneTurnAtATime(t *testing.T) {
	t.Parallel()

	full := NewLimiter(1)
	if err := full.TryAcquire(); err != nil {
		t.Fatal(err)
	}
	f := newRunnerFixture(t, full, nil)
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t1", RequestID: "r", MessageID: "m", Text: "x"}); !errors.Is(err, ErrConcurrencyLimit) {
		t.Fatalf("Send at the limit = %v", err)
	}
	full.Release()
	send(t, f, "t1")
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t2", RequestID: "r2", MessageID: "m2", Text: "y"}); !errors.Is(err, ErrTurnRunning) {
		t.Fatalf("second Send while running = %v", err)
	}
}

func TestClaudeRunnerStoresToolImagesAsAttachments(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	send(t, f, "t1")
	f.adapter(0).emit(t,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu-1","name":"Screenshot","input":{}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":""}`,
	)
	f.turnEvents(t, "t1")
	events, err := f.store.EventsAfter(context.Background(), "conv-1", 0, 1<<30, 100)
	if err != nil {
		t.Fatal(err)
	}
	var attachmentID string
	for _, e := range events {
		if e.ItemID.String == "output-image:tu-1:0" {
			var p map[string]any
			_ = json.Unmarshal([]byte(e.Payload), &p)
			attachmentID, _ = p["attachment_id"].(string)
			if p["kind"] != "image" || p["mime_type"] != "image/png" {
				t.Fatalf("image payload = %v", p)
			}
		}
	}
	if attachmentID == "" {
		t.Fatal("image event has no attachment_id")
	}
	_, path, err := f.store.Attachment(context.Background(), f.scopeID, attachmentID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("attachment bytes = %q, %v", data, err)
	}
}

type failingFiles struct{}

func (failingFiles) WriteAttachmentFile(int64, string, string, []byte, time.Time) (store.NewAttachment, error) {
	return store.NewAttachment{}, errors.New("disk full")
}

func TestClaudeRunnerRecordsAFailedImageWriteAsAnErrorItem(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	f.runner.files = failingFiles{}
	send(t, f, "t1")
	f.adapter(0).emit(t,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu-1","name":"Screenshot","input":{}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":""}`,
	)
	got := f.turnEvents(t, "t1")
	if !strings.Contains(strings.Join(got, "\n"), "item.completed output-image:tu-1:0 failed") {
		t.Fatalf("events = %v", got)
	}
}
