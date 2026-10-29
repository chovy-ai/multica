package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

// fakeCloud is the workspace API for cloud agent turns.
type fakeCloud struct {
	mu       sync.Mutex
	calls    []string
	bodies   map[string]any
	replied  bool
	sessions int
	cancel   bool
}

func (c *fakeCloud) Search(context.Context, string, string, int) (any, error) { return nil, nil }
func (c *fakeCloud) Read(context.Context, string, string, int, string) (any, error) {
	return nil, nil
}
func (c *fakeCloud) Attachment(context.Context, string) (any, error) { return nil, nil }
func (c *fakeCloud) Upload(_ context.Context, _, name, _ string) (string, error) {
	return "cloud-" + name, nil
}

func (c *fakeCloud) Request(_ context.Context, method, path string, body any) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	key := method + " " + path
	c.calls = append(c.calls, key)
	c.bodies[key] = body
	switch {
	case key == "POST /api/chat/sessions":
		c.sessions++
		return map[string]any{"id": fmt.Sprintf("chat-%d", c.sessions), "workspace_id": "w"}, nil
	case strings.HasSuffix(path, "/messages") && method == "POST":
		return map[string]any{"task_id": "task-1"}, nil
	case strings.HasPrefix(path, "/api/tasks/") && strings.HasSuffix(path, "/messages"):
		return []any{
			map[string]any{"seq": float64(1), "type": "tool_use", "tool": "search", "call_id": "c1", "input": map[string]any{"q": "x"}},
			map[string]any{"seq": float64(2), "type": "tool_result", "tool": "search", "call_id": "c1", "output": "found"},
			map[string]any{"seq": float64(3), "type": "text", "content": "Done"},
		}, nil
	case strings.Contains(path, "/messages/page"):
		if !c.replied {
			return map[string]any{"messages": []any{}}, nil
		}
		return map[string]any{"messages": []any{map[string]any{"role": "assistant", "task_id": "task-1", "content": "Done: found it."}}}, nil
	case strings.HasPrefix(path, "/api/agents/"):
		return []any{}, nil
	case strings.HasSuffix(path, "/cancel"):
		if c.cancel {
			return map[string]any{"status": "cancelled"}, nil
		}
		return map[string]any{"status": "running"}, nil
	}
	return nil, fmt.Errorf("unexpected %s", key)
}

func (c *fakeCloud) reply() {
	c.mu.Lock()
	c.replied = true
	c.mu.Unlock()
}

func (c *fakeCloud) count(prefix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.calls {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

func remoteFixture(t *testing.T) (*serviceFixture, *fakeCloud) {
	t.Helper()
	cloud := &fakeCloud{bodies: map[string]any{}}
	f := newServiceFixtureWith(t, filepath.Join(t.TempDir(), "c.sqlite"), Options{Cloud: func(store.Scope, string) contextmcp.Cloud { return cloud }})
	f.create(t, "conv-1", "claude")
	return f, cloud
}

func TestAgentTurnsMirrorTheCloudExecution(t *testing.T) {
	t.Parallel()

	f, cloud := remoteFixture(t)
	ctx := context.Background()
	cmd := SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "@Writer summarize"}
	result, err := f.svc.SendToAgents(ctx, cmd, []RemoteAgent{{ID: "agent-1", Name: "Writer"}, {ID: "agent-2", Name: "Reviewer"}})
	if err != nil || len(result.TurnIDs) != 2 {
		t.Fatalf("send = %+v, %v", result, err)
	}
	again, err := f.svc.SendToAgents(ctx, cmd, []RemoteAgent{{ID: "agent-1", Name: "Writer"}, {ID: "agent-2", Name: "Reviewer"}})
	if err != nil || !again.Replayed || fmt.Sprint(again.TurnIDs) != fmt.Sprint(result.TurnIDs) {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	// The local provider cannot start while agents run.
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r2", Text: "x"}); err != ErrTurnRunning {
		t.Fatalf("local send during agent turns = %v", err)
	}
	eventually(t, "both sends", func() bool { return cloud.count("POST /api/chat/sessions/") == 2 })
	cloud.mu.Lock()
	body := cloud.bodies["POST /api/chat/sessions/chat-1/messages"].(map[string]any)["content"].(string)
	cloud.mu.Unlock()
	if !strings.HasPrefix(body, "Multica conversation display capabilities") || !strings.HasSuffix(body, "@Writer summarize") {
		t.Fatalf("cloud content = %q", body)
	}
	cloud.reply()
	eventually(t, "the agent turns to finish", func() bool {
		turns, _ := f.svc.Store().ConversationTurns(ctx, "conv-1")
		for _, tt := range turns {
			if tt.Status != "completed" {
				return false
			}
		}
		return len(turns) == 2
	})
	messages, _ := f.svc.Store().Messages(ctx, "conv-1")
	if len(messages) != 3 || messages[1].Content != "Done: found it." {
		t.Fatalf("messages = %+v", messages)
	}
	events, _ := f.svc.Store().TurnEvents(ctx, "conv-1", result.TurnIDs[0])
	var mirrored []string
	for _, e := range events {
		if strings.HasPrefix(e.ItemID.String, "remote-") {
			mirrored = append(mirrored, e.Type)
		}
	}
	if strings.Join(mirrored, ",") != "item.started,item.completed,item.delta,item.completed" {
		t.Fatalf("mirrored events = %v", mirrored)
	}

	// The next local turn hears what the agents said.
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r3", Text: "thoughts?"}); err != nil {
		t.Fatal(err)
	}
	sends := f.sends(t)
	prompt := sends[len(sends)-1]
	if !strings.HasPrefix(prompt, "thoughts?\n\nPrior conversation context") || !strings.Contains(prompt, `"name":"Writer"`) || !strings.Contains(prompt, "Done: found it.") {
		t.Fatalf("local prompt = %q", prompt)
	}
	// A later message to the same agent continues its chat.
	f.adapters[0].emit(t, turnDone)
	eventually(t, "the local turn to end", func() bool { b, _ := f.svc.conversationBusy(ctx, "conv-1"); return !b })
	if _, err := f.svc.SendToAgents(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r4", Text: "more"}, []RemoteAgent{{ID: "agent-1", Name: "Writer"}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the follow-up send", func() bool { return cloud.count("POST /api/chat/sessions/chat-") >= 3 })
	if cloud.count("POST /api/chat/sessions") != 3+2 {
		t.Fatalf("calls = %v", cloud.calls)
	}
}

func TestInterruptCancelsAgentTurns(t *testing.T) {
	t.Parallel()

	f, cloud := remoteFixture(t)
	cloud.cancel = true
	ctx := context.Background()
	result, err := f.svc.SendToAgents(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "go"}, []RemoteAgent{{ID: "agent-1", Name: "Writer"}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "the send", func() bool { return cloud.count("POST /api/chat/sessions/chat-1/messages") == 1 })
	eventually(t, "the task id", func() bool {
		turn, _ := f.svc.Store().Turn(ctx, "conv-1", result.TurnIDs[0])
		return strings.Contains(turn.Remote, "task-1")
	})
	if err := f.svc.Interrupt(ctx, f.scopeID, "conv-1"); err != nil {
		t.Fatal(err)
	}
	turn, _ := f.svc.Store().Turn(ctx, "conv-1", result.TurnIDs[0])
	if turn.Status != "cancelled" || cloud.count("POST /api/tasks/task-1/cancel") != 1 {
		t.Fatalf("turn = %s, calls %v", turn.Status, cloud.calls)
	}
	_ = json.Marshal
}

func TestAgentTurnsResumeAfterRestart(t *testing.T) {
	t.Parallel()

	cloud := &fakeCloud{bodies: map[string]any{}}
	path := filepath.Join(t.TempDir(), "c.sqlite")
	opts := Options{Cloud: func(store.Scope, string) contextmcp.Cloud { return cloud }}
	f := newServiceFixtureWith(t, path, opts)
	f.create(t, "conv-1", "claude")
	ctx := context.Background()
	result, err := f.svc.SendToAgents(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "go"}, []RemoteAgent{{ID: "agent-1", Name: "Writer"}})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "the task id", func() bool {
		turn, _ := f.svc.Store().Turn(ctx, "conv-1", result.TurnIDs[0])
		return strings.Contains(turn.Remote, "task-1")
	})
	if err := f.svc.Close(ctx); err != nil {
		t.Fatal(err)
	}

	again := newServiceFixtureWith(t, path, opts)
	turn, _ := again.svc.Store().Turn(ctx, "conv-1", result.TurnIDs[0])
	if turn.Status != "running" {
		t.Fatalf("restart closed the agent turn: %s", turn.Status)
	}
	cloud.reply()
	eventually(t, "the resumed turn to finish", func() bool {
		turn, _ := again.svc.Store().Turn(ctx, "conv-1", result.TurnIDs[0])
		return turn.Status == "completed"
	})
	if sends := cloud.count("POST /api/chat/sessions/chat-1/messages"); sends != 1 {
		t.Fatalf("the restart sent the message again (%d sends)", sends)
	}
}
