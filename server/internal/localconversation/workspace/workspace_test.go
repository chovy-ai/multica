package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

// fakeAPI answers workspace API calls from routes and counts them.
type fakeAPI struct {
	mu     sync.Mutex
	routes map[string]any
	calls  []string
	bodies map[string]map[string]any
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := r.Method + " " + r.URL.RequestURI()
	f.mu.Lock()
	f.calls = append(f.calls, key)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.bodies[key] = body
	value, ok := f.routes[key]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
		return
	}
	_ = json.NewEncoder(w).Encode(value)
}

func (f *fakeAPI) count(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == key {
			n++
		}
	}
	return n
}

func newTools(t *testing.T, routes map[string]any, local Local) (map[string]contextmcp.Tool, *fakeAPI) {
	t.Helper()
	api := &fakeAPI{routes: routes, bodies: map[string]map[string]any{}}
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	client := &contextmcp.CloudClient{APIURL: srv.URL, WorkspaceID: "ws-1", Token: func() string { return "tok" }}
	tools := map[string]contextmcp.Tool{}
	for _, tool := range Tools(Options{WorkspaceID: "ws-1", UserID: "u-1", ConversationID: "conv-self", AppURL: "https://app.example", Request: client, Local: local}) {
		tools[tool.Name] = tool
	}
	return tools, api
}

func call(t *testing.T, tools map[string]contextmcp.Tool, name, args string) (map[string]any, error) {
	t.Helper()
	tool, ok := tools[name]
	if !ok {
		t.Fatalf("no tool %s", name)
	}
	res, err := tool.Call(context.Background(), json.RawMessage(args))
	if err != nil {
		return nil, err
	}
	out, _ := res.Value.(map[string]any)
	return out, nil
}

var workspaceRow = map[string]any{"id": "ws-1", "name": "WS", "slug": "acme"}

func TestCreateTaskIsCheckedLinkedAndIdempotent(t *testing.T) {
	t.Parallel()

	tools, api := newTools(t, map[string]any{
		"GET /api/workspaces/ws-1":  workspaceRow,
		"GET /api/projects/p-1":     map[string]any{"id": "p-1", "workspace_id": "ws-1"},
		"GET /api/projects/p-other": map[string]any{"id": "p-other", "workspace_id": "ws-2"},
		"POST /api/issues":          map[string]any{"id": "i-1", "workspace_id": "ws-1", "identifier": "ACM-1", "api_token": "leak"},
	}, nil)
	args := `{"title":"Fix login","project_id":"p-1","request_id":"op-1"}`
	out, err := call(t, tools, "create_task", args)
	if err != nil {
		t.Fatal(err)
	}
	if out["id"] != "i-1" || out["url"] != "https://app.example/acme/issues/i-1" || out["action"] != "created" {
		t.Fatalf("receipt = %v", out)
	}
	if _, leaked := out["data"].(map[string]any)["api_token"]; leaked {
		t.Fatal("the receipt carries a credential field")
	}
	if _, err := call(t, tools, "create_task", args); err != nil || api.count("POST /api/issues") != 1 {
		t.Fatalf("retry = %v, posts %d", err, api.count("POST /api/issues"))
	}
	if _, err := call(t, tools, "create_task", `{"title":"Other","request_id":"op-1"}`); err == nil || !strings.Contains(err.Error(), "different operation") {
		t.Fatalf("reused request id = %v", err)
	}
	if _, err := call(t, tools, "create_task", `{"title":"X","project_id":"p-other","request_id":"op-2"}`); err == nil || !strings.Contains(err.Error(), "outside the selected workspace") {
		t.Fatalf("foreign project = %v", err)
	}
	for _, bad := range []string{`{"title":"X"}`, `{"title":"X","request_id":"op-3","bogus":1}`, `{"title":"   ","request_id":"op-4"}`} {
		if _, err := call(t, tools, "create_task", bad); err == nil || !strings.Contains(err.Error(), "invalid tool arguments") {
			t.Errorf("accepted %s: %v", bad, err)
		}
	}
}

func TestDeleteNeedsTheCurrentName(t *testing.T) {
	t.Parallel()

	tools, api := newTools(t, map[string]any{
		"GET /api/projects/p-1":    map[string]any{"id": "p-1", "workspace_id": "ws-1", "title": "Roadmap"},
		"DELETE /api/projects/p-1": map[string]any{},
	}, nil)
	if _, err := call(t, tools, "delete_workspace_item", `{"kind":"project","id":"p-1","expected_name":"Other","request_id":"d1"}`); err == nil {
		t.Fatal("deleted with a stale name")
	}
	if _, err := call(t, tools, "delete_workspace_item", `{"kind":"project","id":"p-1","expected_name":"Roadmap","request_id":"d2"}`); err != nil || api.count("DELETE /api/projects/p-1") != 1 {
		t.Fatalf("delete = %v", err)
	}
}

func TestListItemsPagesAndFilters(t *testing.T) {
	t.Parallel()

	tools, _ := newTools(t, map[string]any{
		"GET /api/agents?workspace_id=ws-1": []any{
			map[string]any{"id": "a1", "name": "Writer", "workspace_id": "ws-1", "custom_env": map[string]any{"K": "v"}},
			map[string]any{"id": "a2", "name": "Reviewer", "workspace_id": "ws-1"},
			map[string]any{"id": "a3", "name": "Writer 2", "workspace_id": "ws-1"},
		},
	}, nil)
	out, err := call(t, tools, "list_workspace_items", `{"kind":"agent","query":"writer","limit":1}`)
	if err != nil {
		t.Fatal(err)
	}
	items := out["items"].([]any)
	if len(items) != 1 || out["has_more"] != true || out["next_offset"] != float64(1) {
		t.Fatalf("page = %v", out)
	}
	if _, ok := items[0].(map[string]any)["custom_env"]; ok {
		t.Fatal("private runtime configuration was returned")
	}
}

func TestOperationErrorsKeepTheServerMessageWithoutTheToken(t *testing.T) {
	t.Parallel()

	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"forbidden","error":"token tok cannot do this","plan":{"x":1}}`))
	})
	srv := httptest.NewServer(api)
	defer srv.Close()
	client := &contextmcp.CloudClient{APIURL: srv.URL, WorkspaceID: "ws-1", Token: func() string { return "tok" }}
	_, err := client.Request(context.Background(), http.MethodPost, "/api/issues", map[string]any{})
	var op *contextmcp.OperationError
	if !errors.As(err, &op) || op.Code != "forbidden" || op.Status != 403 || strings.Contains(op.Message, "tok ") || op.Details["plan"] == nil {
		t.Fatalf("error = %#v", err)
	}
}

type fakeLocal struct {
	mu   sync.Mutex
	sent []string
}

func (f *fakeLocal) Create(_ context.Context, provider, title string, _ *string) (Conversation, error) {
	return Conversation{ID: "new", Title: title, Provider: provider}, nil
}
func (f *fakeLocal) Update(_ context.Context, id string, u LocalUpdate) (Conversation, error) {
	return Conversation{ID: id, Archived: u.Archived != nil && *u.Archived}, nil
}
func (f *fakeLocal) Fork(_ context.Context, id, turn, req string) (Conversation, error) {
	return Conversation{ID: "fork-" + req, ForkedFrom: id, ForkedFromTurnID: turn}, nil
}
func (f *fakeLocal) List(context.Context) ([]Conversation, error) {
	return []Conversation{{ID: "a"}, {ID: "b", ForkedFrom: "a"}, {ID: "c"}}, nil
}
func (f *fakeLocal) Send(_ context.Context, id, content, _, req string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, id+":"+content+":"+req)
	return "turn-" + req, nil
}
func (f *fakeLocal) Cancel(context.Context, string, string) error { return nil }

func TestLocalConversationTools(t *testing.T) {
	t.Parallel()

	local := &fakeLocal{}
	tools, _ := newTools(t, map[string]any{}, local)
	if _, err := call(t, tools, "update_conversation", `{"id":"conv-self","archived":true,"request_id":"u1"}`); err == nil {
		t.Fatal("archived the executing conversation")
	}
	if _, err := call(t, tools, "send_conversation_message", `{"id":"conv-self","content":"hi","request_id":"s1"}`); err == nil {
		t.Fatal("sent into the executing conversation")
	}
	out, err := call(t, tools, "send_conversation_message", `{"id":"other","content":"hi","request_id":"s2"}`)
	if err != nil || out["turn_id"] != "turn-s2" {
		t.Fatalf("send = %v, %v", out, err)
	}
	branches, _ := call(t, tools, "list_conversation_branches", `{"source_id":"a"}`)
	if len(branches["items"].([]any)) != 2 {
		t.Fatalf("branches = %v", branches)
	}
	if _, err := call(t, tools, "create_conversation", `{"request_id":"c1"}`); err == nil {
		t.Fatal("created a local conversation without a provider")
	}
}

func TestWithoutCloudOnlyLocalToolsRemain(t *testing.T) {
	t.Parallel()

	for _, tool := range Tools(Options{WorkspaceID: "ws-1", Local: &fakeLocal{}}) {
		if tool.Name == "create_task" || tool.Name == "workspace_info" {
			t.Fatalf("cloud tool %s without cloud access", tool.Name)
		}
	}
}
