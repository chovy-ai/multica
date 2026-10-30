package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestCompactUsesTheExistingSessionAndIsIdempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Compact(ctx, f.scopeID+1, "conv-1", "compact-1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("other scope = %v", err)
	}
	if _, err := f.svc.Compact(ctx, f.scopeID, "conv-1", "compact-1"); !errors.Is(err, ErrCompactUnavailable) {
		t.Fatalf("empty conversation = %v", err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "initial", Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	a := f.adapters[0]
	a.emit(t, `{"type":"system","subtype":"init","session_id":"native-1"}`)
	eventually(t, "native session to be recorded", func() bool {
		c, _ := f.svc.store.Conversation(ctx, "conv-1")
		return c.ProviderSessionID == "native-1"
	})
	if _, err := f.svc.Compact(ctx, f.scopeID, "conv-1", "compact-1"); !errors.Is(err, ErrTurnRunning) {
		t.Fatalf("running conversation = %v", err)
	}
	a.emit(t, turnDone)
	eventually(t, "initial turn to finish", func() bool { c, _ := f.svc.store.Conversation(ctx, "conv-1"); return c.Status == "idle" })
	first, err := f.svc.Compact(ctx, f.scopeID, "conv-1", "compact-1")
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.svc.Compact(ctx, f.scopeID, "conv-1", "compact-1")
	if err != nil || !again.Replayed || again.TurnID != first.TurnID {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	if got := a.sent(); fmt.Sprint(got) != "[start send send]" {
		t.Fatalf("requests = %v", got)
	}
	a.mu.Lock()
	content := fmt.Sprint(a.fields[len(a.fields)-1]["content"])
	a.mu.Unlock()
	if content != "[map[text:/compact type:text]]" {
		t.Fatalf("native command = %s", content)
	}
	a.emit(t, `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":2000}}`, turnDone)
	eventually(t, "compaction to finish", func() bool {
		row, err := f.svc.store.Turn(ctx, "conv-1", first.TurnID)
		return err == nil && row.Status == "completed"
	})
	rows, err := f.svc.store.Messages(ctx, "conv-1")
	if err != nil || len(rows) != 1 || rows[0].Content != "hello" {
		t.Fatalf("authored messages = %+v, %v", rows, err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "compact-1", Text: "different"}); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("reused operation id = %v", err)
	}
}

func TestClaudeCompactRequiresANativeBoundary(t *testing.T) {
	t.Parallel()
	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: "compact", RequestID: "compact", Hidden: true, Compact: true, Text: "/compact"}); err != nil {
		t.Fatal(err)
	}
	f.adapter(0).emit(t, `{"type":"result","subtype":"success","result":"Not enough messages to compact."}`)
	f.turnEvents(t, "compact")
	row, _ := f.store.Turn(context.Background(), "conv-1", "compact")
	if row.Status != "failed" || row.ErrorKind != "compaction_failed" || row.Error != "Not enough messages to compact." {
		t.Fatalf("turn = %+v", row)
	}
}

func TestCodexCompactTracksTheNativeTurnEvenBeforeAcknowledgement(t *testing.T) {
	t.Parallel()
	for _, confirmed := range []bool{true, false} {
		t.Run(fmt.Sprint(confirmed), func(t *testing.T) {
			f, r, server := newCodexFixture(t, CodexSession{ThreadID: "th-1"}, nil)
			t.Cleanup(func() { _ = r.Close(context.Background()) })
			server.reply = func(method string, _ map[string]any) (json.RawMessage, bool) {
				if method != "thread/compact/start" {
					return nil, false
				}
				server.notify(t, "turn/started", `{"threadId":"th-1","turn":{"id":"native-compact"}}`)
				if confirmed {
					server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"native-compact","item":{"id":"compaction","type":"contextCompaction"}}`)
				}
				server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"native-compact","status":"completed"}}`)
				return json.RawMessage(`{}`), true
			}
			if err := r.Send(context.Background(), SendRequest{TurnID: "compact", RequestID: "compact", Hidden: true, Compact: true}); err != nil {
				t.Fatal(err)
			}
			f.turnEvents(t, "compact")
			row, _ := f.store.Turn(context.Background(), "conv-1", "compact")
			want := "failed"
			if confirmed {
				want = "completed"
			}
			if row.Status != want || row.ProviderTurnID != "native-compact" {
				t.Fatalf("turn = %+v", row)
			}
			if got := server.sent(); !slices.Contains(got, "thread/resume") || !slices.Contains(got, "thread/compact/start") || slices.Contains(got, "turn/start") {
				t.Fatalf("requests = %v", got)
			}
			if server.paramsOf("thread/compact/start")["threadId"] != "th-1" {
				t.Fatal("compacted a different thread")
			}
			rows, _ := f.store.Messages(context.Background(), "conv-1")
			if len(rows) != 0 || r.Running() || f.limiter.Running() != 0 {
				t.Fatalf("compaction left messages or a running turn: %+v", rows)
			}
		})
	}
}
