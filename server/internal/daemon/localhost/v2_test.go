package localhost

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/multica-ai/multica/server/internal/localconversation/protocol"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/service"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

const v2Token = "test-token"

// autoAdapter completes every turn right after its prompt is sent.
type autoAdapter struct {
	handler claude.Handler
	done    chan struct{}
	once    sync.Once
}

func (a *autoAdapter) Request(_ context.Context, typ string, _ map[string]any) (json.RawMessage, error) {
	if typ == "send" {
		go func() {
			a.handler(claude.Output{Type: "sdk_message", Message: json.RawMessage(`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"done"}]}}`)})
			a.handler(claude.Output{Type: "sdk_message", Message: json.RawMessage(`{"type":"result","subtype":"success","is_error":false,"result":"done"}`)})
		}()
	}
	return json.RawMessage(`{}`), nil
}
func (a *autoAdapter) Close(context.Context) error { a.once.Do(func() { close(a.done) }); return nil }
func (a *autoAdapter) Done() <-chan struct{}       { return a.done }
func (a *autoAdapter) Err() error                  { return nil }

func newV2Server(t *testing.T) (*httptest.Server, *service.Service) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, desktopUserIDFile), []byte("user-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	svc, err := service.Open(context.Background(), service.Options{
		Path: filepath.Join(dir, "local-conversations", "conversations.sqlite"),
		Claude: func(context.Context, sqlitedb.Conversation) (service.ClaudeSession, service.StartClaudeAdapter, error) {
			return service.ClaudeSession{Fields: map[string]any{"executable": "/bin/claude"}}, func(_ context.Context, h claude.Handler) (service.ClaudeAdapter, error) {
				return &autoAdapter{handler: h, done: make(chan struct{})}, nil
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close(context.Background()) })
	mux := http.NewServeMux()
	NewV2(svc, v2Token, dir).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, svc
}

func v2Headers(user string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+v2Token)
	h.Set(headerAPIOrigin, "https://api.multica.ai")
	h.Set(headerUserID, user)
	h.Set(headerWorkspaceID, "ws-1")
	return h
}

func v2Do(t *testing.T, srv *httptest.Server, method, path string, body any, header http.Header) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, srv.URL+path, reader)
	req.Header = header
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func serverMessageSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	for id, path := range protocol.SchemaFiles {
		raw, err := protocol.Schemas.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := c.AddResource(id, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := c.Compile(protocol.LocalV2ID + "#/$defs/server_message")
	if err != nil {
		t.Fatal(err)
	}
	return schema
}

func TestV2RejectsUnauthorizedAndUnscopedRequests(t *testing.T) {
	t.Parallel()

	srv, _ := newV2Server(t)
	noToken := v2Headers("user-1")
	noToken.Del("Authorization")
	if status, _ := v2Do(t, srv, http.MethodGet, "/local/v2/sessions", nil, noToken); status != http.StatusForbidden {
		t.Fatalf("no token = %d", status)
	}
	noScope := http.Header{"Authorization": {"Bearer " + v2Token}}
	if status, body := v2Do(t, srv, http.MethodGet, "/local/v2/sessions", nil, noScope); status != http.StatusBadRequest || body["error"].(map[string]any)["kind"] != "invalid_scope" {
		t.Fatalf("no scope = %d %v", status, body)
	}
	if status, body := v2Do(t, srv, http.MethodGet, "/local/v2/sessions", nil, v2Headers("someone-else")); status != http.StatusForbidden || body["error"].(map[string]any)["kind"] != "account_mismatch" {
		t.Fatalf("other account = %d %v", status, body)
	}
}

func TestV2SendSnapshotAndCatchUpOverWebSocket(t *testing.T) {
	t.Parallel()

	srv, svc := newV2Server(t)
	h := v2Headers("user-1")
	if status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "conv-1", "provider": "claude", "cwd": "/repo"}, h); status != http.StatusCreated {
		t.Fatalf("create = %d %v", status, body)
	}
	status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "send", "request_id": "req-1", "text": "hi"}, h)
	if status != http.StatusAccepted || body["turn_id"] != "turn-req-1" || body["replayed"] != false {
		t.Fatalf("send = %d %v", status, body)
	}
	if status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "send", "request_id": "req-1", "text": "hi"}, h); status != http.StatusAccepted || body["replayed"] != true {
		t.Fatalf("retry = %d %v", status, body)
	}
	if status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "send", "request_id": "req-1", "text": "changed"}, h); status != http.StatusConflict {
		t.Fatalf("conflict = %d %v", status, body)
	}

	schema := serverMessageSchema(t)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/local/v2/ws"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, h)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := ws.WriteJSON(map[string]any{"version": 2, "type": "subscribe", "conversation_id": "conv-1", "after_seq": 0, "store_generation": svc.Generation()}); err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var types []string
	var statuses []string
	for !containsString(types, "turn.completed") {
		var raw json.RawMessage
		if err := ws.ReadJSON(&raw); err != nil {
			t.Fatalf("read: %v (events %v)", err, types)
		}
		doc, _ := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err := schema.Validate(doc); err != nil {
			t.Fatalf("server message violates the v2 schema: %v\n%s", err, raw)
		}
		var msg struct {
			Type   string `json:"type"`
			Status string `json:"status"`
			Events []struct {
				Type string `json:"type"`
			} `json:"events"`
		}
		_ = json.Unmarshal(raw, &msg)
		if msg.Type == "subscription.status" {
			statuses = append(statuses, msg.Status)
		}
		for _, e := range msg.Events {
			types = append(types, e.Type)
		}
	}
	if fmt.Sprint(types) != "[user.message turn.started item.completed turn.completed]" || statuses[0] != "subscribed" {
		t.Fatalf("events %v statuses %v", types, statuses)
	}

	status, snap := v2Do(t, srv, http.MethodGet, "/local/v2/sessions/conv-1/snapshot", nil, h)
	if status != http.StatusOK || snap["snapshot_seq"].(float64) < 4 || len(snap["turns"].([]any)) != 1 {
		t.Fatalf("snapshot = %d %v", status, snap)
	}
	turn := snap["turns"].([]any)[0].(map[string]any)
	if turn["status"] != "completed" || len(turn["messages"].([]any)) != 2 {
		t.Fatalf("snapshot turn = %v", turn)
	}
}

func TestV2SubscriptionRequiresTheCurrentStoreGeneration(t *testing.T) {
	t.Parallel()

	srv, _ := newV2Server(t)
	h := v2Headers("user-1")
	v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "conv-1", "provider": "claude"}, h)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/local/v2/ws", h)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.WriteJSON(map[string]any{"version": 2, "type": "subscribe", "conversation_id": "conv-1", "after_seq": 0, "store_generation": "old"})
	var msg map[string]any
	_ = ws.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err := ws.ReadJSON(&msg); err != nil || msg["status"] != "snapshot_required" {
		t.Fatalf("status = %v, %v", msg, err)
	}
}

func TestV2ScopeSubscriptionStreamsSummaries(t *testing.T) {
	t.Parallel()

	srv, _ := newV2Server(t)
	h := v2Headers("user-1")
	schema := serverMessageSchema(t)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/local/v2/ws", h)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.WriteJSON(map[string]any{"version": 2, "type": "subscribe_scope", "after_scope_seq": 0})
	v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "conv-1", "provider": "claude", "title": "排查"}, h)
	v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "send", "request_id": "r", "text": "hi"}, h)

	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	seen := map[string]bool{}
	for !seen["idle"] || !seen["running"] {
		var raw json.RawMessage
		if err := ws.ReadJSON(&raw); err != nil {
			t.Fatalf("read: %v (seen %v)", err, seen)
		}
		doc, _ := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err := schema.Validate(doc); err != nil {
			t.Fatalf("server message violates the v2 schema: %v\n%s", err, raw)
		}
		var msg struct {
			Summaries []struct {
				Status string `json:"status"`
			} `json:"summaries"`
		}
		_ = json.Unmarshal(raw, &msg)
		for _, s := range msg.Summaries {
			seen[s.Status] = true
		}
	}
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestV2UpdateSettingsCommand(t *testing.T) {
	t.Parallel()

	srv, svc := newV2Server(t)
	h := v2Headers("user-1")
	v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "conv-1", "provider": "claude"}, h)
	status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "update_settings", "model": "claude-opus-5-5", "permission_mode": "full-access"}, h)
	if status != http.StatusOK {
		t.Fatalf("update = %d %v", status, body)
	}
	conv, _ := svc.Store().Conversation(context.Background(), "conv-1")
	if conv.Model.String != "claude-opus-5-5" || conv.PermissionMode != "full-access" {
		t.Fatalf("stored = %+v", conv)
	}
	if status, _ := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "update_settings", "model": nil}, h); status != http.StatusOK {
		t.Fatalf("reset model = %d", status)
	}
	if conv, _ := svc.Store().Conversation(context.Background(), "conv-1"); conv.Model.Valid || conv.PermissionMode != "full-access" {
		t.Fatalf("after reset = %+v", conv)
	}
	if status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions/conv-1/commands", map[string]any{"type": "update_settings", "permission_mode": "yolo"}, h); status != http.StatusBadRequest || body["error"].(map[string]any)["kind"] != "invalid_settings" {
		t.Fatalf("invalid = %d %v", status, body)
	}
}
