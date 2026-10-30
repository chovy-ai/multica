package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/codex"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
	"github.com/multica-ai/multica/server/pkg/codexappserver"
)

// fakeCodex is a scripted app-server.
type fakeCodex struct {
	mu        sync.Mutex
	handler   codex.Handler
	requests  []string
	params    map[string]map[string]any
	responses []string
	// beforeTurnStart runs inside turn/start before it returns, to emit
	// notifications that race the response.
	beforeTurnStart func()
	// reply, when set, answers a method before the defaults.
	reply func(method string, params map[string]any) (json.RawMessage, bool)
	done  chan struct{}
	once  sync.Once
}

func (f *fakeCodex) Request(_ context.Context, method string, params any) (json.RawMessage, error) {
	f.mu.Lock()
	f.requests = append(f.requests, method)
	data, _ := json.Marshal(params)
	var p map[string]any
	_ = json.Unmarshal(data, &p)
	f.params[method] = p
	hook, reply := f.beforeTurnStart, f.reply
	f.mu.Unlock()
	if reply != nil {
		if out, ok := reply(method, p); ok {
			return out, nil
		}
	}
	switch method {
	case "config/read":
		return json.RawMessage(`{"config":{"developer_instructions":"native","mcp_servers":{"github":{}}}}`), nil
	case "model/list":
		return json.RawMessage(`{"data":[{"id":"gpt-5.5","isDefault":true}]}`), nil
	case "thread/start", "thread/resume":
		return json.RawMessage(`{"thread":{"id":"th-1"}}`), nil
	case "thread/fork":
		return json.RawMessage(`{"thread":{"id":"th-fork"}}`), nil
	case "turn/start":
		if hook != nil {
			hook()
		}
		return json.RawMessage(`{"turn":{"id":"tu-1"}}`), nil
	}
	return json.RawMessage(`{}`), nil
}

func (f *fakeCodex) Respond(id int, result any) {
	data, _ := json.Marshal(result)
	f.mu.Lock()
	f.responses = append(f.responses, fmt.Sprintf("%d:%s", id, data))
	f.mu.Unlock()
}

func (f *fakeCodex) RespondError(id int, code int, message string) {
	f.mu.Lock()
	f.responses = append(f.responses, fmt.Sprintf("%d:error %d", id, code))
	f.mu.Unlock()
}

func (f *fakeCodex) Stop()                 { f.once.Do(func() { close(f.done) }) }
func (f *fakeCodex) Done() <-chan struct{} { return f.done }
func (f *fakeCodex) Err() error            { return codexappserver.ErrProcessExited }

func (f *fakeCodex) notify(t *testing.T, method, params string) {
	t.Helper()
	f.handler(codexappserver.Frame{Kind: codexappserver.FrameNotification, Method: method, Params: json.RawMessage(params)})
}

func (f *fakeCodex) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

func (f *fakeCodex) paramsOf(method string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.params[method]
}

func newCodexFixture(t *testing.T, session CodexSession, setup func(*fakeCodex)) (*runnerFixture, *CodexRunner, *fakeCodex) {
	t.Helper()
	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	server := &fakeCodex{params: map[string]map[string]any{}, done: make(chan struct{})}
	if setup != nil {
		setup(server)
	}
	if session.Cwd == "" {
		session.Cwd = "/repo"
	}
	r := NewCodexRunner(CodexRunnerOptions{
		ConversationID: "conv-1", ScopeID: f.scopeID, Files: f.store, Session: session,
		Batcher: f.batcher, Limiter: f.limiter, ContextMCPName: "multica",
		Start: func(_ context.Context, h codex.Handler, _ []string) (CodexServer, error) {
			server.handler = h
			return server, nil
		},
	})
	return f, r, server
}

func codexSend(t *testing.T, r *CodexRunner, turn string) {
	t.Helper()
	if err := r.Send(context.Background(), SendRequest{TurnID: turn, RequestID: "req-" + turn, MessageID: "msg-" + turn, Text: "跑一下测试"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

func TestCodexRunnerRecordsACompletedTurn(t *testing.T) {
	t.Parallel()

	f, r, server := newCodexFixture(t, CodexSession{}, nil)
	codexSend(t, r, "t1")
	if got := server.sent(); fmt.Sprint(got) != "[config/read thread/start turn/start]" {
		t.Fatalf("requests = %v", got)
	}
	start := server.paramsOf("thread/start")
	if start["developerInstructions"] != "native" || fmt.Sprint(start["config"]) != "map[mcp_servers:map[github:map[enabled:false]]]" {
		t.Fatalf("thread/start params = %v", start)
	}
	server.notify(t, "item/agentMessage/delta", `{"threadId":"th-1","turnId":"tu-1","itemId":"a1","delta":"通过"}`)
	server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"a1","type":"agentMessage","text":"测试通过。"}}`)
	// Other threads and turns are ignored.
	server.notify(t, "item/completed", `{"threadId":"th-other","turnId":"tu-1","item":{"id":"x","type":"agentMessage","text":"no"}}`)
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)

	got := f.turnEvents(t, "t1")
	want := []string{"user.message  <nil>", "turn.started  <nil>", "item.started a1 <nil>", "item.delta a1 <nil>", "item.completed a1 completed", "turn.completed  completed"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events:\n%v\nwant:\n%v", got, want)
	}
	conv, _ := f.store.Conversation(context.Background(), "conv-1")
	if conv.ProviderSessionID != "th-1" || conv.LastMessagePreview != "测试通过。" {
		t.Fatalf("conversation = session %q preview %q", conv.ProviderSessionID, conv.LastMessagePreview)
	}
	if f.limiter.Running() != 0 {
		t.Fatal("limiter slot leaked")
	}
}

func TestCodexRunnerFiltersReplayBeforeTheTurnIsKnown(t *testing.T) {
	t.Parallel()

	f, r, server := newCodexFixture(t, CodexSession{}, func(s *fakeCodex) {
		s.beforeTurnStart = func() {
			// Resume replay of an old turn, then the new turn's first item,
			// both before the turn/start response.
			s.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-0","item":{"id":"old","type":"agentMessage","text":"replayed"}}`)
			s.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"new","type":"agentMessage","text":"fresh"}}`)
		}
	})
	codexSend(t, r, "t1")
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
	got := f.turnEvents(t, "t1")
	want := []string{"user.message  <nil>", "turn.started  <nil>", "item.completed new completed", "turn.completed  completed"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestCodexRunnerResumesWithAnExplicitDefaultModel(t *testing.T) {
	t.Parallel()

	full := "full-access"
	_, r, server := newCodexFixture(t, CodexSession{ThreadID: "th-1", PermissionMode: full}, nil)
	codexSend(t, r, "t1")
	if got := server.sent(); fmt.Sprint(got) != "[config/read model/list thread/resume turn/start]" {
		t.Fatalf("requests = %v", got)
	}
	resume := server.paramsOf("thread/resume")
	if resume["threadId"] != "th-1" || resume["excludeTurns"] != true || resume["model"] != "gpt-5.5" ||
		resume["approvalPolicy"] != "never" || resume["sandbox"] != "danger-full-access" {
		t.Fatalf("thread/resume params = %v", resume)
	}
}

func TestCodexRunnerDeclinesApprovalRequests(t *testing.T) {
	t.Parallel()

	f, r, server := newCodexFixture(t, CodexSession{}, nil)
	codexSend(t, r, "t1")
	server.handler(codexappserver.Frame{Kind: codexappserver.FrameServerRequest, ID: 7, Method: "item/commandExecution/requestApproval",
		Params: json.RawMessage(`{"threadId":"th-1","turnId":"tu-1","itemId":"c1"}`)})
	server.handler(codexappserver.Frame{Kind: codexappserver.FrameServerRequest, ID: 8, Method: "tool/unknown",
		Params: json.RawMessage(`{"threadId":"th-1","turnId":"tu-1"}`)})
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
	got := f.turnEvents(t, "t1")
	if fmt.Sprint(got[2:4]) != "[item.completed declined:7 failed item.completed declined:8 failed]" {
		t.Fatalf("events = %v", got)
	}
	server.mu.Lock()
	responses := fmt.Sprint(server.responses)
	server.mu.Unlock()
	if responses != `[7:{"decision":"cancel"} 8:error -32601]` {
		t.Fatalf("responses = %s", responses)
	}
}

func TestCodexRunnerFailsTheTurnWhenAppServerExits(t *testing.T) {
	t.Parallel()

	f, r, server := newCodexFixture(t, CodexSession{}, nil)
	codexSend(t, r, "t1")
	server.notify(t, "item/agentMessage/delta", `{"threadId":"th-1","turnId":"tu-1","itemId":"a1","delta":"half"}`)
	server.Stop()
	got := f.turnEvents(t, "t1")
	if got[len(got)-2] != "item.completed a1 failed" || got[len(got)-1] != "turn.completed  failed" {
		t.Fatalf("events = %v", got)
	}
}

func TestCodexRunnerInterruptsTheRunningTurn(t *testing.T) {
	t.Parallel()

	f, r, server := newCodexFixture(t, CodexSession{}, nil)
	codexSend(t, r, "t1")
	if err := r.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p := server.paramsOf("turn/interrupt"); p["threadId"] != "th-1" || p["turnId"] != "tu-1" {
		t.Fatalf("turn/interrupt params = %v", p)
	}
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"interrupted"}}`)
	if got := f.turnEvents(t, "t1"); got[len(got)-1] != "turn.completed  cancelled" {
		t.Fatalf("events = %v", got)
	}
}

func TestServiceRunsCodexConversations(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "c.sqlite")
	server := &fakeCodex{params: map[string]map[string]any{}, done: make(chan struct{})}
	svc, err := Open(context.Background(), Options{Path: path,
		Codex: func(context.Context, sqlitedb.Conversation) (CodexSession, StartCodexServer, error) {
			return CodexSession{}, func(_ context.Context, h codex.Handler, _ []string) (CodexServer, error) {
				server.handler = h
				return server, nil
			}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(context.Background())
	ctx := context.Background()
	scopeID, _ := svc.Store().EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
	if _, err := svc.Store().CreateConversation(ctx, store.NewConversation{ID: "conv-c", ScopeID: scopeID, Provider: "codex", Cwd: "/repo", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.Send(ctx, SendCommand{ScopeID: scopeID, ConversationID: "conv-c", RequestID: "r1", Text: "hi"})
	if err != nil || result.TurnID == "" {
		t.Fatalf("Send = %+v, %v", result, err)
	}
	if p := server.paramsOf("thread/start"); p["cwd"] != "/repo" {
		t.Fatalf("thread/start params = %v", p)
	}
}

func TestCodexRunnerConfiguresTheContextServer(t *testing.T) {
	t.Parallel()

	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	server := &fakeCodex{params: map[string]map[string]any{}, done: make(chan struct{})}
	var env []string
	released := make(chan struct{})
	r := NewCodexRunner(CodexRunnerOptions{
		ConversationID: "conv-1", ScopeID: f.scopeID, Files: f.store, Session: CodexSession{Cwd: "/repo"},
		Batcher: f.batcher, Limiter: f.limiter,
		Start: func(_ context.Context, h codex.Handler, e []string) (CodexServer, error) {
			server.handler, env = h, e
			return server, nil
		},
		Context: func(_ context.Context, token string, _ func() map[string]any) (BoundContext, func(), error) {
			if fmt.Sprint(env) != "["+ContextTokenEnv+"="+token+"]" {
				t.Errorf("app-server env %v does not carry the route token", env)
			}
			return BoundContext{Binding: contextmcp.Binding{URL: "http://127.0.0.1:1/mcp/route", Token: token}, SystemPrompt: "multica prompt"}, func() { close(released) }, nil
		},
	})
	codexSend(t, r, "t1")
	mcp := server.paramsOf("thread/start")["config"].(map[string]any)["mcp_servers"].(map[string]any)
	entry := mcp[contextmcp.Name].(map[string]any)
	if entry["url"] != "http://127.0.0.1:1/mcp/route" || entry["bearer_token_env_var"] != ContextTokenEnv || entry["required"] != true {
		t.Fatalf("context entry = %v", entry)
	}
	if instructions, _ := server.paramsOf("thread/start")["developerInstructions"].(string); !strings.HasSuffix(instructions, "multica prompt") {
		t.Fatalf("developer instructions = %q", instructions)
	}
	server.Stop()
	select {
	case <-released:
	case <-time.After(2 * time.Second):
		t.Fatal("context route not released when app-server exited")
	}
}
