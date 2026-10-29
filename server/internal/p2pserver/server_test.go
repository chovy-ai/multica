package p2pserver

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

// fakeAPI stands in for the Multica API server's GET /api/me.
type fakeAPI struct {
	users map[string]string // token -> user id
	calls atomic.Int32
	down  atomic.Bool
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	if f.down.Load() {
		http.Error(w, "down", http.StatusBadGateway)
		return
	}
	if r.URL.Path != "/api/me" {
		http.NotFound(w, r)
		return
	}
	id, ok := f.users[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"id": id, "email": "x@example.com"})
}

type harness struct {
	api   *fakeAPI
	srv   *Server
	http  *httptest.Server
	clock time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	api := &fakeAPI{users: map[string]string{"tok-alice": "user-alice", "tok-alice-2": "user-alice", "tok-bob": "user-bob"}}
	apiSrv := httptest.NewServer(api)
	t.Cleanup(apiSrv.Close)
	store, err := OpenStore(filepath.Join(t.TempDir(), "p2p.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h := &harness{api: api, clock: time.Now()}
	h.srv = &Server{Auth: NewMeAuthenticator(apiSrv.URL, time.Minute), Store: store, Now: func() time.Time { return h.clock }}
	h.http = httptest.NewServer(h.srv.Handler())
	t.Cleanup(h.http.Close)
	return h
}

func (h *harness) do(t *testing.T, method, path, token string, body any) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, _ := http.NewRequest(method, h.http.URL+path, &buf)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out bytes.Buffer
	out.ReadFrom(resp.Body)
	return resp.StatusCode, out.Bytes()
}

func (h *harness) devices(t *testing.T, token string) []Device {
	t.Helper()
	code, body := h.do(t, http.MethodGet, "/v1/devices", token, nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %s", code, body)
	}
	var resp struct {
		Devices []Device `json:"devices"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Devices
}

func newKey(t *testing.T) (string, peer.ID) {
	t.Helper()
	_, pub, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := crypto.MarshalPublicKey(pub)
	id, _ := peer.IDFromPublicKey(pub)
	return base64.StdEncoding.EncodeToString(raw), id
}

func TestRegisterListDeleteIsScopedToAccount(t *testing.T) {
	h := newHarness(t)
	keyA, idA := newKey(t)
	keyW, _ := newKey(t)
	keyB, _ := newKey(t)

	for _, tc := range []struct {
		token string
		body  registerRequest
	}{
		{"tok-alice", registerRequest{DaemonID: "m1", PublicKey: keyA, DeviceName: "laptop"}},
		{"tok-alice-2", registerRequest{DaemonID: "m1", Profile: "work", PublicKey: keyW}},
		{"tok-bob", registerRequest{DaemonID: "m1", PublicKey: keyB}},
	} {
		if code, body := h.do(t, http.MethodPost, "/v1/devices", tc.token, tc.body); code != http.StatusOK {
			t.Fatalf("register: %d %s", code, body)
		}
	}
	// Re-registering a profile replaces its key rather than adding a row.
	keyA2, idA2 := newKey(t)
	h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", PublicKey: keyA2, DeviceName: "laptop-2"})

	alice := h.devices(t, "tok-alice")
	if len(alice) != 2 {
		t.Fatalf("alice devices = %+v, want her two profiles only", alice)
	}
	if alice[0].Profile != "" || alice[0].PeerID != idA2.String() || alice[0].DeviceName != "laptop-2" {
		t.Fatalf("default profile = %+v, want refreshed key (old %s)", alice[0], idA)
	}
	if bob := h.devices(t, "tok-bob"); len(bob) != 1 {
		t.Fatalf("bob devices = %+v", bob)
	}

	// Bob cannot remove Alice's device even with the same daemon id.
	if code, _ := h.do(t, http.MethodDelete, "/v1/devices?daemon_id=m1&profile=work", "tok-bob", nil); code != http.StatusNotFound {
		t.Fatalf("cross-account delete = %d, want 404", code)
	}
	if code, _ := h.do(t, http.MethodDelete, "/v1/devices?daemon_id=m1&profile=work", "tok-alice", nil); code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	if got := h.devices(t, "tok-alice"); len(got) != 1 {
		t.Fatalf("after delete = %+v", got)
	}
}

func TestRejectsInvalidKeys(t *testing.T) {
	h := newHarness(t)
	rsaKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	_, rsaPub, _ := crypto.KeyPairFromStdKey(rsaKey)
	rsaRaw, _ := crypto.MarshalPublicKey(rsaPub)
	for name, key := range map[string]string{
		"not base64": "%%%",
		"not a key":  base64.StdEncoding.EncodeToString([]byte("short")),
		"rsa":        base64.StdEncoding.EncodeToString(rsaRaw),
	} {
		if code, _ := h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", PublicKey: key}); code != http.StatusBadRequest {
			t.Errorf("%s: got %d, want 400", name, code)
		}
	}
}

func TestAuthFailuresAreClosed(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.do(t, http.MethodGet, "/v1/devices", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token = %d", code)
	}
	if code, _ := h.do(t, http.MethodGet, "/v1/devices", "tok-unknown", nil); code != http.StatusUnauthorized {
		t.Fatalf("rejected token = %d", code)
	}
	h.api.down.Store(true)
	if code, _ := h.do(t, http.MethodGet, "/v1/devices", "tok-alice", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("API down = %d, want 503 rather than admitting the request", code)
	}
}

func TestTokenCheckIsCachedByHash(t *testing.T) {
	h := newHarness(t)
	for range 5 {
		h.devices(t, "tok-alice")
	}
	if n := h.api.calls.Load(); n != 1 {
		t.Fatalf("API server called %d times, want 1", n)
	}
	auth := h.srv.Auth.(*MeAuthenticator)
	for k := range auth.cache {
		if strings.Contains(k, "tok-alice") {
			t.Fatal("cache key contains the raw token")
		}
	}
}

func TestStaleDevicesExpire(t *testing.T) {
	h := newHarness(t)
	key, _ := newKey(t)
	h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", PublicKey: key})
	if len(h.devices(t, "tok-alice")) != 1 {
		t.Fatal("fresh device missing")
	}
	h.clock = h.clock.Add(DefaultDeviceTTL + time.Minute)
	if got := h.devices(t, "tok-alice"); len(got) != 0 {
		t.Fatalf("expired device still listed: %+v", got)
	}
	n, err := h.srv.Store.PurgeBefore(context.Background(), h.clock.Add(-DefaultDeviceTTL))
	if err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
}

func TestMeAuthenticatorRejectsMalformedResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"name":"no id"}`))
	}))
	defer srv.Close()
	_, err := NewMeAuthenticator(srv.URL, time.Minute).UserID(context.Background(), "t")
	if !errors.Is(err, ErrAuthUnavailable) {
		t.Fatalf("got %v, want ErrAuthUnavailable", err)
	}
}
