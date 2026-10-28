package localhost

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testToken = "test-local-token"

type harness struct {
	t       *testing.T
	srv     *Server
	http    *httptest.Server
	profile string
}

func newHarness(t *testing.T, supported bool) *harness {
	t.Helper()
	profile := t.TempDir()
	cfg := Config{DataDir: filepath.Join(t.TempDir(), "data"), ProfileDir: profile, Token: testToken, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if supported {
		cfg.Sidecar = &Sidecar{ProtocolVersion: 2}
		cfg.Command = fakeSidecarCommand()
	}
	srv := NewServer(cfg)
	mux := http.NewServeMux()
	srv.Register(mux)
	h := &harness{t: t, srv: srv, http: httptest.NewServer(mux), profile: profile}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = srv.Close(ctx)
		h.http.Close()
	})
	return h
}

func (h *harness) signIn(user string) {
	h.t.Helper()
	if err := os.WriteFile(filepath.Join(h.profile, desktopUserIDFile), []byte(user+"\n"), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) url(path string) string { return h.http.URL + path }

type testClient struct {
	conn          *Conn
	notifications chan notification
	hostReplies   func(id string, payload json.RawMessage) (any, error)
}

type notification struct {
	method string
	params json.RawMessage
}

func (h *harness) dial() *testClient {
	h.t.Helper()
	header := http.Header{"Authorization": {"Bearer " + testToken}}
	ws, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(h.url("/local/v1/ws"), "http"), header)
	if err != nil {
		h.t.Fatalf("dial: %v (%v)", err, resp)
	}
	c := &testClient{notifications: make(chan notification, 256)}
	c.conn = NewConn(newWSTransport(ws), func(_ context.Context, method string, params json.RawMessage) (any, error) {
		c.notifications <- notification{method, params}
		return nil, nil
	})
	h.t.Cleanup(func() { _ = c.conn.Close() })
	return c
}

func (c *testClient) call(t *testing.T, method string, params any) (json.RawMessage, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return c.conn.CallRaw(ctx, method, params)
}

func (c *testClient) next(t *testing.T, method string) json.RawMessage {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case n := <-c.notifications:
			if n.method == method {
				return n.params
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", method)
		}
	}
}

func appCode(err error) string {
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) {
		return ""
	}
	data, _ := json.Marshal(rpcErr.Data)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(data, &body)
	return body.Code
}

var scope = Scope{APIURL: "https://api.example", UserID: "user-1", WorkspaceID: "ws-1"}

func (h *harness) session(c *testClient) string {
	h.t.Helper()
	raw, err := c.call(h.t, "session.set", map[string]any{"userId": scope.UserID, "apiUrl": scope.APIURL, "env": map[string]string{"PATH": "/usr/bin"}})
	if err != nil {
		h.t.Fatalf("session.set: %v", err)
	}
	var out struct {
		ConnectionID string `json:"connectionId"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.ConnectionID
}

func TestLocalAPIRejectsUnauthorizedRequests(t *testing.T) {
	h := newHarness(t, true)
	cases := map[string]func(*http.Request){
		"missing token": func(*http.Request) {},
		"wrong token":   func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") },
		"browser origin": func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+testToken)
			r.Header.Set("Origin", "https://evil.example")
		},
		"rebinding host": func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken); r.Host = "evil.example" },
	}
	for name, mutate := range cases {
		for _, path := range []string{"/local/v1/hello", "/local/v1/ws"} {
			req, _ := http.NewRequest(http.MethodGet, h.url(path), nil)
			mutate(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("%s %s: status %d, want 403", name, path, resp.StatusCode)
			}
		}
	}
}

func TestLargeMessagesRoundTripThroughWebSocketAndSidecar(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	client := h.dial()
	h.session(client)
	for _, text := range []string{strings.Repeat("x", (1<<20)-1), strings.Repeat("会话🙂", 200_000), "next"} {
		raw, err := client.call(t, "request", map[string]any{
			"scope": scope, "method": "echo", "params": map[string]string{"text": text},
		})
		if err != nil {
			t.Fatalf("echo %d bytes: %v", len(text), err)
		}
		var result struct {
			Params struct {
				Text string `json:"text"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		if result.Params.Text != text {
			t.Fatalf("echo %d bytes was changed or truncated", len(text))
		}
	}
}

func TestHelloReportsUnsupportedWithoutSidecar(t *testing.T) {
	h := newHarness(t, false)
	req, _ := http.NewRequest(http.MethodGet, h.url("/local/v1/hello"), nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var hello Hello
	_ = json.NewDecoder(resp.Body).Decode(&hello)
	if hello.APIVersion != APIVersion || hello.Sidecar.Status != StatusUnsupported {
		t.Fatalf("unexpected hello: %+v", hello)
	}
	c := h.dial()
	h.signIn(scope.UserID)
	if _, err := c.call(t, "session.set", map[string]any{"userId": scope.UserID}); appCode(err) != "unsupported" {
		t.Fatalf("session.set = %v, want unsupported", err)
	}
}

func TestSessionRequiresTheProfileAccount(t *testing.T) {
	h := newHarness(t, true)
	c := h.dial()
	if _, err := c.call(t, "session.set", map[string]any{"userId": scope.UserID}); appCode(err) != "not_signed_in" {
		t.Fatalf("no profile user: %v", err)
	}
	h.signIn("someone-else")
	if _, err := c.call(t, "session.set", map[string]any{"userId": scope.UserID}); appCode(err) != "account_mismatch" {
		t.Fatalf("other profile user: %v", err)
	}
	if _, err := c.call(t, "request", map[string]any{"scope": scope, "method": "echo"}); appCode(err) != "account_mismatch" {
		t.Fatalf("request before session: %v", err)
	}
}

func TestRequestRoundTripCarriesConnection(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	c := h.dial()
	connID := h.session(c)
	raw, err := c.call(t, "request", map[string]any{"scope": scope, "method": "echo", "params": map[string]any{"x": 1}})
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		ConnectionID string          `json:"connectionId"`
		Params       json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(raw, &out)
	if out.ConnectionID != connID || string(out.Params) != `{"x":1}` {
		t.Fatalf("unexpected echo: %s", raw)
	}
	other := scope
	other.UserID = "user-2"
	if _, err := c.call(t, "request", map[string]any{"scope": other, "method": "echo"}); appCode(err) != "account_mismatch" {
		t.Fatalf("cross-account request: %v", err)
	}
}

func TestEventsReplayFromCursorOrResync(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	c := h.dial()
	h.session(c)
	if _, err := c.call(t, "subscribe", map[string]any{"since": ""}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.call(t, "request", map[string]any{"scope": scope, "method": "emit", "params": 3}); err != nil {
		t.Fatal(err)
	}
	var first struct {
		Cursor string `json:"cursor"`
	}
	_ = json.Unmarshal(c.next(t, "event"), &first)
	c.next(t, "event")
	c.next(t, "event")

	late := h.dial()
	h.session(late)
	if _, err := late.call(t, "subscribe", map[string]any{"since": first.Cursor}); err != nil {
		t.Fatal(err)
	}
	late.next(t, "event")
	late.next(t, "event")
	select {
	case n := <-late.notifications:
		if n.method == "event" || n.method == "resync" {
			t.Fatalf("unexpected extra %s after replay", n.method)
		}
	case <-time.After(200 * time.Millisecond):
	}

	stale := h.dial()
	h.session(stale)
	raw, err := stale.call(t, "subscribe", map[string]any{"since": "old-instance:7"})
	if err != nil || !strings.Contains(string(raw), `"resync":true`) {
		t.Fatalf("stale cursor: %s %v", raw, err)
	}
	stale.next(t, "resync")
}

func TestHostRequestGoesOnlyToOriginAndFirstReplyWins(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	origin := h.dial()
	h.session(origin)
	bystander := h.dial()
	h.session(bystander)

	result := make(chan json.RawMessage, 1)
	go func() {
		raw, err := origin.call(t, "request", map[string]any{"scope": scope, "method": "ask", "params": map[string]any{"op": "settings_update"}})
		if err != nil {
			t.Errorf("ask: %v", err)
		}
		result <- raw
	}()
	var req struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(origin.next(t, "hostRequest"), &req)
	if req.Kind != "confirmed_operation" {
		t.Fatalf("kind = %q", req.Kind)
	}
	if _, err := bystander.call(t, "hostReply", map[string]any{"id": req.ID, "result": map[string]any{"approved": true}}); appCode(err) != "host_request_resolved" {
		t.Fatalf("bystander reply accepted: %v", err)
	}
	if _, err := origin.call(t, "hostReply", map[string]any{"id": req.ID, "result": map[string]any{"applied": true}}); err != nil {
		t.Fatal(err)
	}
	if got := <-result; string(got) != `{"applied":true}` {
		t.Fatalf("result = %s", got)
	}
	if _, err := origin.call(t, "hostReply", map[string]any{"id": req.ID, "result": map[string]any{}}); appCode(err) != "host_request_resolved" {
		t.Fatalf("second reply accepted: %v", err)
	}
}

func TestSideWorkspaceHostRequestPreservesPayloadAndImageReply(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	origin := h.dial()
	h.session(origin)
	connectionID := mustConnID(t, h, origin)
	payload := json.RawMessage(`{"op":"browser","conversationId":"main","tabId":"web:one","turnId":"turn","action":{"type":"screenshot"}}`)
	type outcome struct {
		value any
		err   error
	}
	result := make(chan outcome, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		value, err := h.srv.hostRequest(ctx, connectionID, "side_workspace", payload)
		result <- outcome{value, err}
	}()
	var request HostRequestNotification
	if err := json.Unmarshal(origin.next(t, "hostRequest"), &request); err != nil {
		t.Fatal(err)
	}
	if request.Kind != "side_workspace" || !bytes.Equal(request.Payload, payload) {
		t.Fatalf("forwarded request = %s %s", request.Kind, request.Payload)
	}
	image := strings.Repeat("A", 650*1024*4/3)
	reply := map[string]any{"untrusted_page_content": true, "image": map[string]any{"mimeType": "image/jpeg", "data": image}}
	if _, err := origin.call(t, "hostReply", map[string]any{"id": request.ID, "result": reply}); err != nil {
		t.Fatal(err)
	}
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	encoded, err := json.Marshal(got.value)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(image)) {
		t.Fatalf("image reply size = %d", len(encoded))
	}
}

func TestHostRequestFailsFastWhenOriginDisconnects(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	origin := h.dial()
	h.session(origin)
	observer := h.dial()
	h.session(observer)

	// The fake sidecar asks on behalf of the observer's connection while the
	// request travels through the origin; closing the observer must fail it.
	errs := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		conn, err := h.srv.sup.Ensure(ctx)
		if err != nil {
			errs <- err
			return
		}
		_, err = h.srv.hostRequest(ctx, mustConnID(t, h, observer), "pick_directory", json.RawMessage(`{}`))
		errs <- err
		_ = conn
	}()
	observer.next(t, "hostRequest")
	start := time.Now()
	_ = observer.conn.Close()
	if err := <-errs; appCode(err) != "settings_host_unavailable" {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("disconnect did not fail the pending request promptly")
	}
	if _, err := h.srv.hostRequest(context.Background(), "missing", "confirm", nil); appCode(err) != "settings_host_unavailable" {
		t.Fatalf("unknown connection: %v", err)
	}
}

func mustConnID(t *testing.T, h *harness, c *testClient) string {
	t.Helper()
	raw, err := c.call(t, "request", map[string]any{"scope": scope, "method": "echo"})
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		ConnectionID string `json:"connectionId"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.ConnectionID
}

func TestCrashedSidecarRestartsAndForcesResync(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	c := h.dial()
	h.session(c)
	if _, err := c.call(t, "subscribe", map[string]any{"since": ""}); err != nil {
		t.Fatal(err)
	}
	_, before := h.srv.sup.Status()
	_, _ = c.call(t, "request", map[string]any{"scope": scope, "method": "crash"})
	c.next(t, "resync")
	status, after := h.srv.sup.Status()
	if status != StatusReady || after == before || h.srv.sup.Crashes() != 1 {
		t.Fatalf("status=%s before=%s after=%s crashes=%d", status, before, after, h.srv.sup.Crashes())
	}
}

func TestDrainReportsBusyWork(t *testing.T) {
	h := newHarness(t, true)
	if busy, err := h.srv.Drain(context.Background()); err != nil || busy != 0 {
		t.Fatalf("drain before start = %d, %v", busy, err)
	}
	h.signIn(scope.UserID)
	c := h.dial()
	h.session(c)
	if _, err := c.call(t, "request", map[string]any{"scope": scope, "method": "work", "params": 2}); err != nil {
		t.Fatal(err)
	}
	raw, err := c.call(t, "sidecar.drain", map[string]any{})
	if err != nil || !strings.Contains(string(raw), `"busy":2`) {
		t.Fatalf("drain = %s, %v", raw, err)
	}
	if status, _ := h.srv.sup.Status(); status != StatusDraining {
		t.Fatalf("status = %s", status)
	}
	if h.srv.Busy() != 2 {
		t.Fatalf("Busy() = %d", h.srv.Busy())
	}
	if _, err := c.call(t, "sidecar.undrain", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.srv.sup.Status(); status != StatusReady {
		t.Fatalf("status after undrain = %s", status)
	}
}

func fileURL(h *harness, path string) string {
	q := url.Values{"apiUrl": {scope.APIURL}, "userId": {scope.UserID}, "workspaceId": {scope.WorkspaceID}}
	return h.url(path) + "?" + q.Encode()
}

func TestFilesStreamOverHTTP(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	body := bytes.Repeat([]byte("0123456789"), 1000)
	req, _ := http.NewRequest(http.MethodPost, fileURL(h, "/local/v1/files"), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("X-File-Name", url.PathEscape("notes 笔记.txt"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var up struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&up)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || up.ID != "stored-notes 笔记.txt" {
		t.Fatalf("upload: %d %+v", resp.StatusCode, up)
	}

	get, _ := http.NewRequest(http.MethodGet, fileURL(h, "/local/v1/files/"+url.PathEscape(up.ID)), nil)
	get.Header.Set("Authorization", "Bearer "+testToken)
	get.Header.Set("Range", "bytes=10-19")
	resp, err = http.DefaultClient.Do(get)
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || string(part) != "0123456789" || resp.Header.Get("Content-Type") != "text/plain" {
		t.Fatalf("range read: %d %q %s", resp.StatusCode, part, resp.Header.Get("Content-Type"))
	}

	bad, _ := http.NewRequest(http.MethodGet, fileURL(h, "/local/v1/files/"+url.PathEscape("../secret")), nil)
	bad.Header.Set("Authorization", "Bearer "+testToken)
	resp, err = http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("traversal status = %d", resp.StatusCode)
	}
}

func TestUploadRejectsOversizedBody(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	req, _ := http.NewRequest(http.MethodPost, fileURL(h, "/local/v1/files"), io.LimitReader(zeroReader{}, maxUploadBytes+1))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-File-Name", "big.bin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	entries, _ := os.ReadDir(filepath.Join(h.srv.cfg.DataDir, "uploads"))
	if len(entries) != 0 {
		t.Fatalf("temporary upload left behind: %d", len(entries))
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestStopShutsSidecarDownAndAllowsRestart(t *testing.T) {
	h := newHarness(t, true)
	h.signIn(scope.UserID)
	c := h.dial()
	h.session(c)
	if err := h.srv.sup.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.srv.sup.Status(); status != StatusIdle {
		t.Fatalf("status after stop = %s", status)
	}
	if h.srv.sup.Crashes() != 0 {
		t.Fatal("a requested stop counted as a crash")
	}
	if _, err := c.call(t, "request", map[string]any{"scope": scope, "method": "echo"}); err != nil {
		t.Fatalf("request after stop should restart the sidecar: %v", err)
	}
}
