package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

type sideFixture struct {
	*serviceFixture
	tools map[string]contextmcp.Tool
	mu    sync.Mutex
	hosts []map[string]any
	dir   string
}

func newSideFixture(t *testing.T) *sideFixture {
	t.Helper()
	f := &sideFixture{serviceFixture: newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))}
	f.dir, _ = filepath.EvalSymlinks(t.TempDir())
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	f.create(t, "side-1", "claude")
	f.svc.SetHost(func(_ context.Context, _ int64, _ string, kind string, payload any) (json.RawMessage, error) {
		data, _ := json.Marshal(payload)
		var p map[string]any
		_ = json.Unmarshal(data, &p)
		p["kind"] = kind
		f.mu.Lock()
		f.hosts = append(f.hosts, p)
		f.mu.Unlock()
		return json.RawMessage(`{"ok":true,"image":{"mimeType":"image/png","data":"aGk="}}`), nil
	})
	must(t, os.WriteFile(filepath.Join(f.dir, "notes.txt"), []byte("hello side"), 0o600))
	must(t, os.Mkdir(filepath.Join(f.dir, "docs"), 0o700))
	must(t, os.WriteFile(filepath.Join(f.dir, "docs", "a.md"), []byte("# a"), 0o600))
	selected := "web"
	if _, err := f.svc.SyncSideWorkspace(ctx, f.scopeID, SideWorkspace{ConversationID: "conv-1", Revision: 2, PanelOpen: true, Visible: true, SelectedTabID: &selected, Tabs: []SideTab{
		{ID: "web", Kind: "web", URL: "https://example.com/", Title: "Example"},
		{ID: "dir", Kind: "file", Root: f.dir, Path: "docs", FileKind: "directory"},
		{ID: "side", Kind: "side", SessionID: "side-1"},
	}}); err != nil {
		t.Fatal(err)
	}
	conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
	read := func(context.Context, json.RawMessage) (contextmcp.Result, error) {
		return contextmcp.Result{Value: "read"}, nil
	}
	f.tools = map[string]contextmcp.Tool{}
	for _, tool := range f.svc.sideToolsFor(conv, func() map[string]any { return map[string]any{"turn_id": "turn-x"} }, read) {
		f.tools[tool.Name] = tool
	}
	return f
}

func (f *sideFixture) call(t *testing.T, name, args string) (contextmcp.Result, error) {
	t.Helper()
	return f.tools[name].Call(context.Background(), json.RawMessage(args))
}

func TestSideWorkspaceSyncKeepsTheNewestValidRevision(t *testing.T) {
	t.Parallel()

	f := newSideFixture(t)
	ctx := context.Background()
	if rev, _ := f.svc.SyncSideWorkspace(ctx, f.scopeID, SideWorkspace{ConversationID: "conv-1", Revision: 1}); rev != 2 {
		t.Fatalf("an older revision replaced the workspace: %d", rev)
	}
	for _, bad := range []SideWorkspace{
		{ConversationID: "conv-1", Revision: 3, Tabs: []SideTab{{ID: "a", Kind: "web", URL: "file:///etc/passwd"}}},
		{ConversationID: "conv-1", Revision: 3, Tabs: []SideTab{{ID: "a", Kind: "web", URL: "https://u:p@x.com"}}},
		{ConversationID: "conv-1", Revision: 3, Tabs: []SideTab{{ID: "a", Kind: "side", SessionID: "s"}, {ID: "a", Kind: "side", SessionID: "t"}}},
		{ConversationID: "conv-1", Revision: 3, SelectedTabID: new(string)},
	} {
		if _, err := f.svc.SyncSideWorkspace(ctx, f.scopeID, bad); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("accepted %+v", bad)
		}
	}
	if ambient := f.svc.sideAmbient(ctx, f.scopeID, "conv-1"); !strings.Contains(ambient, `"focused_tab_id":"web"`) || !strings.HasPrefix(ambient, "<side-context") {
		t.Fatalf("ambient = %s", ambient)
	}
}

func TestSideToolsReadOnlyOpenTabs(t *testing.T) {
	t.Parallel()

	f := newSideFixture(t)
	res, err := f.call(t, "side_read_file", `{"tab_id":"dir","path":"a.md"}`)
	if err != nil || res.Value.(map[string]any)["text"] != "# a" {
		t.Fatalf("read = %+v, %v", res, err)
	}
	if _, err := f.call(t, "side_read_file", `{"tab_id":"dir","path":"../notes.txt"}`); err == nil || !strings.Contains(err.Error(), "outside this file tab") {
		t.Fatalf("escape = %v", err)
	}
	if _, err := f.call(t, "side_read_file", `{"path":"`+filepath.Join(f.dir, "notes.txt")+`"}`); err == nil {
		t.Fatal("read a file no tab opens")
	}
	res, err = f.call(t, "side_browser_click", `{"tab_id":"web","ref":"e3","request_id":"c1"}`)
	if err != nil || res.Image == nil {
		t.Fatalf("click = %+v, %v", res, err)
	}
	host := f.hosts[len(f.hosts)-1]
	if host["kind"] != "side.control" || host["op"] != "browser" || host["turnId"] != "turn-x" || host["action"].(map[string]any)["ref"] != "e3" {
		t.Fatalf("control = %v", host)
	}
	if _, err := f.call(t, "side_browser_click", `{"tab_id":"dir","request_id":"c2"}`); err == nil {
		t.Fatal("browser action on a file tab")
	}
	if _, err := f.call(t, "side_browser_click", `{"tab_id":"web"}`); err == nil {
		t.Fatal("browser write without request_id")
	}
	if _, err := f.call(t, "side_open_tab", `{"kind":"side","session_id":"conv-1","request_id":"o1"}`); err == nil {
		t.Fatal("opened the conversation inside itself")
	}
}

func TestSideConversationSendRunsOrQueues(t *testing.T) {
	t.Parallel()

	f := newSideFixture(t)
	res, err := f.call(t, "side_conversation_send", `{"id":"side","content":"go","request_id":"m1"}`)
	if err != nil || res.Value.(map[string]any)["mode"] != "new_run" || res.Value.(map[string]any)["conversation_id"] != "side-1" {
		t.Fatalf("send = %+v, %v", res, err)
	}
	again, err := f.call(t, "side_conversation_send", `{"id":"side","content":"go","request_id":"m1"}`)
	if err != nil || again.Value.(map[string]any)["turn_id"] != res.Value.(map[string]any)["turn_id"] {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	// Claude cannot be steered, so a second message waits in the queue.
	queued, err := f.call(t, "side_conversation_send", `{"id":"side","content":"then this","request_id":"m2"}`)
	if err != nil || queued.Value.(map[string]any)["mode"] != "queued" {
		t.Fatalf("second send = %+v, %v", queued, err)
	}
	if _, err := f.call(t, "side_conversation_send", `{"id":"conv-1","content":"x","request_id":"m3"}`); err == nil {
		t.Fatal("sent to a conversation that is not an open Side tab")
	}
}
