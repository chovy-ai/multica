package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestStopBackgroundTasksStopsOnlyOpenTasks(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	item := func(id, typ string, final bool, payload string) store.NewEvent {
		return store.NewEvent{TurnID: "turn-r1", ItemID: id, Type: typ, Final: final, Payload: json.RawMessage(payload), CreatedAt: time.Now()}
	}
	_, err := f.svc.batcher.AppendWait(ctx, store.Batch{ConversationID: "conv-1", Events: []store.NewEvent{
		item("bg-1", "item.started", false, `{"kind":"background_task","task_id":"t1","description":"watch"}`),
		item("bg-2", "item.started", false, `{"kind":"background_task","task_id":"t2","description":"done"}`),
		item("bg-2", "item.completed", true, `{"kind":"background_task","status":"completed","task_id":"t2","description":"done"}`),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.StopBackgroundTasks(ctx, f.scopeID, "conv-1"); err != nil {
		t.Fatal(err)
	}
	a := f.adapters[0]
	a.mu.Lock()
	defer a.mu.Unlock()
	var stopped []any
	for i, typ := range a.requests {
		if typ == "stop_task" {
			stopped = append(stopped, a.fields[i]["task_id"])
		}
	}
	if fmt.Sprint(stopped) != "[t1]" {
		t.Fatalf("stopped = %v", stopped)
	}
}

func TestProvidersWithoutACatalog(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	for _, p := range f.svc.Providers(context.Background()) {
		if p.Available {
			t.Fatalf("provider without catalog = %+v", p)
		}
	}
}
