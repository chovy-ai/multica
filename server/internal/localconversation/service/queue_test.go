package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func queued(id, content string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"requestId":%q,"content":%q,"display":{"id":%q,"createdAtUnixMs":1,"content":[{"type":"text","text":%q}]}}`, id, content, id, content))
}

const turnDone = `{"type":"result","subtype":"success","is_error":false,"result":""}`

func (f *serviceFixture) sends(t *testing.T) []string {
	t.Helper()
	var texts []string
	for _, a := range f.allAdapters() {
		a.mu.Lock()
		for i, typ := range a.requests {
			if typ == "send" {
				texts = append(texts, a.fields[i]["content"].([]map[string]any)[0]["text"].(string))
			}
		}
		a.mu.Unlock()
	}
	return texts
}

func (f *serviceFixture) allAdapters() []*fakeAdapter {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*fakeAdapter(nil), f.adapters...)
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestQueueRunsAfterTheCurrentTurn(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r0", Text: "first"}); err != nil {
		t.Fatal(err)
	}
	view, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q1", "second"), false)
	if err != nil || len(view.Items) != 1 {
		t.Fatalf("enqueue = %+v, %v", view, err)
	}
	// The same item again is a no-op; another item under its id is not.
	if again, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q1", "second"), false); err != nil || len(again.Items) != 1 {
		t.Fatalf("repeat = %+v, %v", again, err)
	}
	if _, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q1", "other"), false); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("conflict = %v", err)
	}
	if _, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q2", "third"), false); err != nil {
		t.Fatal(err)
	}
	conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
	if conv.QueueCount != 2 {
		t.Fatalf("queue count = %d", conv.QueueCount)
	}

	f.adapters[0].emit(t, turnDone)
	eventually(t, "the first queued message", func() bool { return fmt.Sprint(f.sends(t)) == "[first second]" })
	f.adapters[0].emit(t, turnDone)
	eventually(t, "the second queued message", func() bool { return fmt.Sprint(f.sends(t)) == "[first second third]" })
	eventually(t, "an empty queue", func() bool {
		view, _ := f.svc.Queue(ctx, f.scopeID, "conv-1")
		conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
		return len(view.Items) == 0 && conv.QueueCount == 0
	})
	// A message that was already sent is not queued again.
	if view, _ := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q1", "second"), false); len(view.Items) != 0 {
		t.Fatalf("re-enqueued a sent message: %+v", view)
	}
}

func TestQueueActions(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r0", Text: "first"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c"} {
		if _, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued(id, id), id == "a"); err != nil {
			t.Fatal(err)
		}
	}
	view, _ := f.svc.Queue(ctx, f.scopeID, "conv-1")
	if view.Paused {
		t.Fatal("a later unpaused enqueue should resume the queue")
	}
	if view, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "remove", "b"); err != nil || len(view.Items) != 2 {
		t.Fatalf("remove = %+v, %v", view, err)
	}
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "remove", "missing"); err != nil {
		t.Fatalf("removing an unknown item = %v", err)
	}
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "jump", ""); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("unknown action = %v", err)
	}

	// send_now interrupts the running turn and runs the item next.
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "send_now", "c"); err != nil {
		t.Fatal(err)
	}
	if got := f.adapters[0].sent(); !strings.Contains(fmt.Sprint(got), "interrupt") {
		t.Fatalf("adapter requests = %v", got)
	}
	f.adapters[0].emit(t, `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["interrupted"]}`)
	eventually(t, "the moved item", func() bool { return fmt.Sprint(f.sends(t)) == "[first c]" })
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "remove", "c"); !errors.Is(err, ErrQueueItemStarted) {
		t.Fatalf("removing a started item = %v", err)
	}

	// stop pauses: nothing runs after the turn ends until resume.
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "stop", ""); err != nil {
		t.Fatal(err)
	}
	f.adapters[0].emit(t, turnDone)
	time.Sleep(50 * time.Millisecond)
	if got := f.sends(t); len(got) != 2 {
		t.Fatalf("a stopped queue sent %v", got)
	}
	if _, err := f.svc.UpdateQueue(ctx, f.scopeID, "conv-1", "resume", ""); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the resumed item", func() bool { return fmt.Sprint(f.sends(t)) == "[first c a]" })
}

func TestQueueRejectsInvalidItems(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	for _, raw := range []string{
		`{"requestId":"a","content":"x","display":{"id":"other"}}`,
		`{"requestId":"a","content":"","display":{"id":"a"}}`,
		`{"requestId":"a","content":"x","display":{"id":"a"},"agents":[{"id":"g","name":"G"}]}`,
		`{"requestId":"a","content":"x","display":{"id":"a"},"permissionMode":"yolo"}`,
	} {
		if _, err := f.svc.Enqueue(context.Background(), f.scopeID, "conv-1", json.RawMessage(raw), false); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestQueueResumesAfterRestart(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "c.sqlite")
	f := newServiceFixture(t, path)
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r0", Text: "first"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Enqueue(ctx, f.scopeID, "conv-1", queued("q1", "after restart"), false); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Close(ctx); err != nil {
		t.Fatal(err)
	}

	again := newServiceFixture(t, path)
	eventually(t, "the queued message after restart", func() bool { return fmt.Sprint(again.sends(t)) == "[after restart]" })
}
