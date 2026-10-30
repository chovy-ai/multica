package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/codex"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

func TestImportClaudeSessionsFromTheirForks(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	cwd := t.TempDir()
	sessions := map[string]string{"src-1": cwd, "src-2": "/no/such/dir", "branch-1": cwd}
	f.mu.Lock()
	f.reply = func(a *fakeAdapter, typ string) (json.RawMessage, error) {
		a.mu.Lock()
		fields := a.fields[len(a.fields)-1]
		a.mu.Unlock()
		id, _ := fields["session_id"].(string)
		switch typ {
		case "list_sessions":
			return json.RawMessage(fmt.Sprintf(`[{"sessionId":"src-1","cwd":%q,"summary":"Fix login","lastModified":1793000000000},{"sessionId":"no-cwd"}]`, cwd)), nil
		case "get_session_info":
			if dir, ok := sessions[id]; ok {
				return json.RawMessage(fmt.Sprintf(`{"sessionId":%q,"cwd":%q,"summary":"Fix login","createdAt":1793000000000}`, id, dir)), nil
			}
			return json.RawMessage(`null`), nil
		case "get_session_messages":
			return json.RawMessage(`[
				{"type":"user","message":{"content":"why does login crash?"}},
				{"type":"assistant","message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","name":"Read","input":{"path":"a.ts"}}]}},
				{"type":"assistant","message":{"content":[{"type":"text","text":"Null user."}]}},
				{"type":"user","message":{"content":[{"type":"text","text":"fix it"}]}},
				{"type":"assistant","message":{"content":"Fixed."}}
			]`), nil
		case "fork_session":
			if id == "src-1" {
				return json.RawMessage(`{"session_id":"branch-1"}`), nil
			}
			return json.RawMessage(`{"session_id":"branch-x"}`), nil
		}
		return json.RawMessage(`{}`), nil
	}
	f.mu.Unlock()

	page, err := f.svc.ImportList(ctx, f.scopeID, "claude", "")
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].Title != "Fix login" || page.NextCursor != nil {
		t.Fatalf("list = %+v, %v", page, err)
	}
	result, err := f.svc.Import(ctx, f.scopeID, "claude", []string{"src-1", "src-2", "src-1"}, nil)
	if err != nil || len(result.Imported) != 1 || len(result.Failed) != 1 || !strings.Contains(result.Failed[0].Error, "working directory") {
		t.Fatalf("import = %+v, %v", result, err)
	}
	conv, _ := f.svc.Store().Conversation(ctx, result.Imported[0].ConversationID)
	if conv.ProviderSessionID != "branch-1" || conv.ImportedFromSessionID != "src-1" || conv.TurnCount != 2 || conv.LastMessagePreview != "Fixed." || conv.Title != "Fix login" {
		t.Fatalf("imported conversation = %+v", conv)
	}
	messages, _ := f.svc.Store().Messages(ctx, conv.ID)
	var roles []string
	for _, m := range messages {
		roles = append(roles, m.Role+":"+m.Content)
	}
	if strings.Join(roles, "|") != "user:why does login crash?|assistant:Let me look.|assistant:Null user.|user:fix it|assistant:Fixed." {
		t.Fatalf("messages = %v", roles)
	}

	again, _ := f.svc.Import(ctx, f.scopeID, "claude", []string{"src-1"}, nil)
	if len(again.Skipped) != 1 || again.Skipped[0].ConversationID != conv.ID {
		t.Fatalf("re-import = %+v", again)
	}
	page, _ = f.svc.ImportList(ctx, f.scopeID, "claude", "")
	if page.Sessions[0].ImportedID != conv.ID {
		t.Fatalf("listed import = %+v", page.Sessions[0])
	}
	if _, err := f.svc.Import(ctx, f.scopeID, "claude", []string{"../etc"}, nil); err == nil {
		t.Fatal("accepted an invalid session id")
	}
}

func TestImportCodexThreads(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	cwd := t.TempDir()
	thread := func(id string) string {
		return fmt.Sprintf(`{"id":%q,"name":"Refactor","cwd":%q,"createdAt":1793000000,"updatedAt":1793000100}`, id, cwd)
	}
	server := &fakeCodex{params: map[string]map[string]any{}, done: make(chan struct{})}
	server.reply = func(method string, p map[string]any) (json.RawMessage, bool) {
		switch method {
		case "thread/list":
			if p["archived"] == true {
				return json.RawMessage(`{"data":[],"nextCursor":null}`), true
			}
			return json.RawMessage(`{"data":[` + thread("th-src") + `,{"id":"tmp","cwd":"/x","createdAt":1,"ephemeral":true}],"nextCursor":null}`), true
		case "thread/read":
			return json.RawMessage(`{"thread":` + thread(p["threadId"].(string)) + `}`), true
		case "thread/turns/list":
			return json.RawMessage(`{"data":[{"status":"completed","startedAt":1793000000,"itemsView":"full","items":[
				{"type":"userMessage","content":[{"type":"text","text":"split this file"}]},
				{"type":"commandExecution","command":"wc -l a.go","aggregatedOutput":"900 a.go","exitCode":0},
				{"type":"agentMessage","text":"Split into three files."}]}],"nextCursor":null}`), true
		case "thread/fork":
			return json.RawMessage(`{"thread":{"id":"th-branch"}}`), true
		}
		return nil, false
	}
	svc, err := Open(ctx, Options{Path: filepath.Join(t.TempDir(), "c.sqlite"), Codex: func(_ context.Context, conv sqlitedb.Conversation) (CodexSession, StartCodexServer, error) {
		return CodexSession{Cwd: conv.Cwd}, func(_ context.Context, h codex.Handler, _ []string) (CodexServer, error) { return server, nil }, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close(ctx) })
	scopeID, _ := svc.Store().EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})

	page, err := svc.ImportList(ctx, scopeID, "codex", "")
	if err != nil || len(page.Sessions) != 1 || page.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", page, err)
	}
	archived, err := svc.ImportList(ctx, scopeID, "codex", *page.NextCursor)
	if err != nil || len(archived.Sessions) != 0 || archived.NextCursor != nil {
		t.Fatalf("archived page = %+v, %v", archived, err)
	}
	result, err := svc.Import(ctx, scopeID, "codex", []string{"th-src"}, nil)
	if err != nil || len(result.Imported) != 1 {
		t.Fatalf("import = %+v, %v", result, err)
	}
	conv, _ := svc.Store().Conversation(ctx, result.Imported[0].ConversationID)
	if conv.ProviderSessionID != "th-branch" || conv.LastMessagePreview != "Split into three files." {
		t.Fatalf("conversation = %+v", conv)
	}
	events, _ := svc.Store().EventsAfter(ctx, conv.ID, 0, conv.LastSeq, 100)
	var command string
	for _, e := range events {
		if strings.Contains(e.Payload, `"kind":"command"`) {
			command = e.Payload
		}
	}
	if !strings.Contains(command, "900 a.go") {
		t.Fatalf("command item = %s", command)
	}
}
