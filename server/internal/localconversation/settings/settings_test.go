package settings

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
)

func TestEveryOperationHasARouteOrIsHostOnly(t *testing.T) {
	t.Parallel()

	names := map[string]bool{}
	for _, op := range Operations() {
		names[op.Name] = true
		_, api := routes[op.Name]
		if api == hostOnly[op.Name] {
			t.Errorf("%s: api route %v, host only %v", op.Name, api, hostOnly[op.Name])
		}
	}
	for name := range routes {
		if !names[name] {
			t.Errorf("route %s is not in the registry", name)
		}
	}
}

type fakeAPI struct {
	mu     sync.Mutex
	calls  []string
	bodies []any
	reply  map[string]any
}

func (f *fakeAPI) Request(_ context.Context, method, path string, body any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := method + " " + path
	f.calls = append(f.calls, key)
	f.bodies = append(f.bodies, body)
	if v, ok := f.reply[key]; ok {
		if err, ok := v.(error); ok {
			return nil, err
		}
		return v, nil
	}
	return nil, &contextmcp.OperationError{Code: "not_found", Message: "missing " + key, Status: 404}
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

type memReceipts struct {
	mu   sync.Mutex
	rows map[string]*Receipt
}

func (m *memReceipts) Claim(_ context.Context, key, fingerprint string) (*Receipt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[key]; r != nil {
		copy := *r
		return &copy, nil
	}
	m.rows[key] = &Receipt{Fingerprint: fingerprint}
	return nil, nil
}

func (m *memReceipts) Finish(_ context.Context, key, result string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[key].Result = result
	return nil
}

type hostCall struct {
	kind    string
	payload map[string]any
}

func setup(t *testing.T, reply map[string]any, host func(kind string, payload map[string]any) (any, error)) (map[string]contextmcp.Tool, *fakeAPI, *[]hostCall) {
	t.Helper()
	api := &fakeAPI{reply: reply}
	var calls []hostCall
	var mu sync.Mutex
	opts := Options{Scope: Scope{WorkspaceID: "ws-1", UserID: "u-1"}, Request: api, Receipts: &memReceipts{rows: map[string]*Receipt{}}}
	if host != nil {
		opts.Host = func(_ context.Context, kind string, payload any) (json.RawMessage, error) {
			data, _ := json.Marshal(payload)
			var p map[string]any
			_ = json.Unmarshal(data, &p)
			mu.Lock()
			calls = append(calls, hostCall{kind, p})
			mu.Unlock()
			v, err := host(kind, p)
			if err != nil {
				return nil, err
			}
			out, _ := json.Marshal(v)
			return out, nil
		}
	}
	tools := map[string]contextmcp.Tool{}
	for _, tool := range Tools(opts) {
		tools[tool.Name] = tool
	}
	return tools, api, &calls
}

func run(t *testing.T, tools map[string]contextmcp.Tool, name, args string) (any, error) {
	t.Helper()
	tool, ok := tools[name]
	if !ok {
		t.Fatalf("no tool %s", name)
	}
	res, err := tool.Call(context.Background(), json.RawMessage(args))
	return res.Value, err
}

func TestConfirmedWritesAreAppliedByDesktop(t *testing.T) {
	t.Parallel()

	approve := true
	tools, api, calls := setup(t, map[string]any{}, func(kind string, payload map[string]any) (any, error) {
		if kind == "settings.confirm" {
			if !approve {
				return map[string]any{"approved": false}, nil
			}
			return map[string]any{"approved": true, "raw": map[string]any{"email": "a@example.com"}}, nil
		}
		return map[string]any{}, nil
	})
	v, err := run(t, tools, "settings_invite_member", `{"email":"a@example.com","request_id":"r1"}`)
	if err != nil || v.(map[string]any)["status"] != "applied" {
		t.Fatalf("invite = %v, %v", v, err)
	}
	if api.count("POST /api/workspaces/ws-1/members") != 0 {
		t.Fatal("the daemon performed a confirmed write itself")
	}
	confirm := (*calls)[0]
	apply := confirm.payload["apply"].(map[string]any)
	if confirm.kind != "settings.confirm" || apply["method"] != "POST" || apply["path"] != "/api/workspaces/ws-1/members" || confirm.payload["input"].(map[string]any)["role"] != "member" {
		t.Fatalf("confirmation = %+v", confirm)
	}
	if (*calls)[len(*calls)-1].kind != "settings.refresh" {
		t.Fatal("the Settings UI was not refreshed")
	}

	approve = false
	v, err = run(t, tools, "settings_invite_member", `{"email":"b@example.com","request_id":"r2"}`)
	if err != nil || v.(map[string]any)["status"] != "cancelled" {
		t.Fatalf("declined = %v, %v", v, err)
	}
	// An agent cannot approve through its own input.
	if _, err := run(t, tools, "settings_invite_member", `{"email":"c@example.com","approved":true,"request_id":"r3"}`); err == nil {
		t.Fatal("accepted an agent-supplied approval field")
	}
}

func TestWritesRunOncePerRequestID(t *testing.T) {
	t.Parallel()

	tools, api, _ := setup(t, map[string]any{
		"POST /api/labels": map[string]any{"id": "l1", "workspace_id": "ws-1", "name": "bug"},
		"PATCH /api/me":    errors.New("connection reset"),
		"GET /api/me":      map[string]any{"id": "u-1"},
	}, nil)
	args := `{"name":"bug","color":"#ff0000","request_id":"x1"}`
	first, err := run(t, tools, "settings_create_label", args)
	if err != nil {
		t.Fatal(err)
	}
	again, err := run(t, tools, "settings_create_label", args)
	if err != nil || api.count("POST /api/labels") != 1 || again.(map[string]any)["status"] != first.(map[string]any)["status"] {
		t.Fatalf("retry = %v, %v (posts %d)", again, err, api.count("POST /api/labels"))
	}
	if _, err := run(t, tools, "settings_create_label", `{"name":"other","color":"#ff0000","request_id":"x1"}`); err == nil || !strings.Contains(err.Error(), "different input") {
		t.Fatalf("conflict = %v", err)
	}
	profile := `{"fields":{"name":"Me"},"request_id":"p1"}`
	if _, err := run(t, tools, "settings_update_profile", profile); err == nil {
		t.Fatal("transport failure reported as success")
	}
	if _, err := run(t, tools, "settings_update_profile", profile); err == nil || !strings.Contains(err.Error(), "already attempted") {
		t.Fatalf("unknown outcome replayed: %v", err)
	}
	if api.count("PATCH /api/me") != 1 {
		t.Fatal("an uncertain write was repeated")
	}
	if _, err := run(t, tools, "settings_update_profile", `{"fields":{},"request_id":"p2"}`); err == nil {
		t.Fatal("accepted an empty patch")
	}
	if _, err := run(t, tools, "settings_update_profile", `{"fields":{"timezone":"Mars/Base"},"request_id":"p3"}`); err == nil {
		t.Fatal("accepted an unknown time zone")
	}
}

func TestCodeSettingsMergeAndScopeChecks(t *testing.T) {
	t.Parallel()

	tools, api, _ := setup(t, map[string]any{
		"GET /api/workspaces/ws-1":   map[string]any{"id": "ws-1", "settings": map[string]any{"github_enabled": true, "other": 1}},
		"PATCH /api/workspaces/ws-1": map[string]any{"id": "ws-1"},
		"GET /api/tokens":            []any{map[string]any{"id": "t1", "name": "ci", "token_prefix": "mul_", "token": "secret"}},
	}, nil)
	if _, err := run(t, tools, "settings_update_code_settings", `{"fields":{"co_authored_by_enabled":false},"request_id":"c1"}`); err != nil {
		t.Fatal(err)
	}
	body := api.bodies[len(api.bodies)-1].(map[string]any)["settings"].(map[string]any)
	if body["github_enabled"] != true || body["other"] != float64(1) && body["other"] != 1 || body["co_authored_by_enabled"] != false {
		t.Fatalf("merged settings = %v", body)
	}
	tokens, err := run(t, tools, "settings_list_tokens", `{}`)
	if err != nil || strings.Contains(mustJSON(tokens), "secret") {
		t.Fatalf("tokens = %v, %v", tokens, err)
	}
	if _, ok := tools["settings_read_device"]; ok {
		t.Fatal("device operations offered without Desktop")
	}
	if _, ok := tools["settings_create_token"]; ok {
		t.Fatal("token creation offered without Desktop to show the secret")
	}
	_ = http.MethodGet
}

func mustJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}
