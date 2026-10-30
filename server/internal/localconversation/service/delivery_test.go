package service

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	taskStarted = `{"type":"system","subtype":"task_started","task_id":"t1","description":"watch build"}`
	taskEnded   = `{"type":"system","subtype":"task_notification","task_id":"t1","status":"completed","summary":"build passed"}`
)

// startBackgroundTask runs a turn that starts task t1 and ends.
func startBackgroundTask(t *testing.T) *serviceFixture {
	t.Helper()
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	f.create(t, "conv-1", "claude")
	if _, err := f.svc.Send(context.Background(), SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "build in background"}); err != nil {
		t.Fatal(err)
	}
	f.adapters[0].emit(t, taskStarted, turnDone)
	eventually(t, "the first turn to end", func() bool {
		c, _ := f.svc.Store().Conversation(context.Background(), "conv-1")
		return c.Status == "idle"
	})
	return f
}

func (f *serviceFixture) taskFinal(t *testing.T) string {
	t.Helper()
	events, _ := f.svc.Store().TurnEvents(context.Background(), "conv-1", "turn-r1")
	for _, e := range events {
		if e.ItemID.String == "task:t1" && e.Final == 1 {
			return e.Payload
		}
	}
	return ""
}

func TestBackgroundResultsAreRecordedAndDeliveredOnce(t *testing.T) {
	t.Parallel()

	f := startBackgroundTask(t)
	f.adapters[0].emit(t, taskEnded)
	eventually(t, "the task's final event under its turn", func() bool { return strings.Contains(f.taskFinal(t), "build passed") })
	eventually(t, "the follow-up", func() bool {
		sends := f.sends(t)
		return len(sends) == 2 && strings.HasPrefix(sends[1], "Background work from an earlier turn has ended") && strings.Contains(sends[1], "build passed")
	})
	messages, _ := f.svc.Store().Messages(context.Background(), "conv-1")
	for _, m := range messages {
		if m.Role == "user" && strings.Contains(m.Content, "Background work") {
			t.Fatal("the follow-up prompt became a user message")
		}
	}
}

func TestClaudesOwnReplySupersedesDelivery(t *testing.T) {
	t.Parallel()

	f := startBackgroundTask(t)
	f.adapters[0].emit(t, taskEnded, `{"type":"assistant","uuid":"u9","message":{"id":"m9","content":[{"type":"text","text":"The build passed."}]}}`, turnDone)
	time.Sleep(2 * deliveryDelay)
	if sends := f.sends(t); len(sends) != 1 {
		t.Fatalf("sends = %v", sends)
	}
	running, _ := f.svc.Store().RunningTurns(context.Background())
	if len(running) != 0 {
		t.Fatalf("native turn still running: %+v", running)
	}
	conv, _ := f.svc.Store().Conversation(context.Background(), "conv-1")
	if conv.TurnCount != 2 || conv.LastMessagePreview != "The build passed." {
		t.Fatalf("native reply = %d turns, preview %q", conv.TurnCount, conv.LastMessagePreview)
	}
}

func TestStoppedTasksNeedNoFollowUp(t *testing.T) {
	t.Parallel()

	f := startBackgroundTask(t)
	if err := f.svc.StopBackgroundTasks(context.Background(), f.scopeID, "conv-1"); err != nil {
		t.Fatal(err)
	}
	f.adapters[0].emit(t, `{"type":"system","subtype":"task_notification","task_id":"t1","status":"stopped"}`)
	eventually(t, "the stopped task's final event", func() bool { return strings.Contains(f.taskFinal(t), "cancelled") })
	time.Sleep(2 * deliveryDelay)
	if sends := f.sends(t); len(sends) != 1 {
		t.Fatalf("sends = %v", sends)
	}
}
