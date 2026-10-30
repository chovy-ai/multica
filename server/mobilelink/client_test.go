package mobilelink

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

func TestMobileClientUsesAuthenticatedDeviceStreamAndClosesWebSockets(t *testing.T) {
	var mu sync.Mutex
	devices := []map[string]any{}
	registryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/v1/sessions" {
			if r.Header.Get("Authorization") != "Bearer login" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"session_token": "session", "expires_at": time.Now().Add(time.Hour)})
			return
		}
		if r.Header.Get("Authorization") != "Bearer session" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/v1/devices":
			if r.Method == "POST" {
				var device map[string]any
				_ = json.NewDecoder(r.Body).Decode(&device)
				devices = append(devices, device)
				_ = json.NewEncoder(w).Encode(device)
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"devices": devices})
			}
		case "/v1/config":
			_ = json.NewEncoder(w).Encode(map[string]any{"relay": nil})
		default:
			http.NotFound(w, r)
		}
	}))
	defer registryServer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	key, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	registryClient := &registry{url: registryServer.URL, login: "login", http: registryServer.Client()}
	desktop, err := p2p.Start(ctx, p2p.Config{Key: key, Fetch: registryClient.peers, ListenAddrs: []string{"/ip4/127.0.0.1/tcp/0"}})
	if err != nil {
		t.Fatal(err)
	}
	defer desktop.Close()
	pub, _ := crypto.MarshalPublicKey(key.GetPublic())
	if err := registryClient.call(ctx, "POST", "/v1/devices", map[string]any{"public_key": base64.StdEncoding.EncodeToString(pub), "device_name": "Test Mac", "addrs": desktop.Status().ListenAddrs}, nil); err != nil {
		t.Fatal(err)
	}
	listener, stop := desktop.Listen(deviceProtocol)
	defer stop()
	var receivedMu sync.Mutex
	var received http.Header
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedMu.Lock()
		received = r.Header.Clone()
		receivedMu.Unlock()
		if r.URL.Path == "/local/v2/ws" {
			ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			for {
				kind, data, err := ws.ReadMessage()
				if err != nil {
					return
				}
				if ws.WriteMessage(kind, data) != nil {
					return
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":2,"capabilities":["device-link"]}`)
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	config, _ := json.Marshal(configuration{RegistryURL: registryServer.URL, APIURL: "https://api.example.test", Token: "login", UserID: "account-a", StoragePath: t.TempDir(), DeviceName: "Test iPhone"})
	client, err := Start(string(config))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := desktop.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if err := client.svc.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for client.svc.Connection(desktop.ID()) == "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if client.svc.Connection(desktop.ID()) == "" {
		t.Fatal("test devices did not connect")
	}
	base := client.endpoint + "/devices/" + desktop.ID().String() + "/local/v2"
	request := func(token, workspace string) *http.Response {
		req, _ := http.NewRequest("GET", base+"/hello", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Workspace-ID", workspace)
		req.Header.Set("X-Multica-User-ID", "spoofed")
		req.Header.Set("X-Multica-API-Origin", "https://other.test")
		res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	for _, test := range []struct {
		token, workspace string
		status           int
	}{{"wrong", "ws", 403}, {client.token, "", 400}, {client.token, "workspace-a", 200}} {
		res := request(test.token, test.workspace)
		_ = res.Body.Close()
		if res.StatusCode != test.status {
			t.Fatalf("status %d, want %d", res.StatusCode, test.status)
		}
	}
	receivedMu.Lock()
	headers := received.Clone()
	receivedMu.Unlock()
	if headers.Get("Authorization") != "" || headers.Get("X-Multica-User-ID") != "account-a" || headers.Get("X-Multica-API-Origin") != "https://api.example.test" || headers.Get("X-Workspace-ID") != "workspace-a" {
		t.Fatalf("incorrect scope headers: %v", headers)
	}
	headers = http.Header{"Authorization": {"Bearer " + client.token}, "X-Workspace-ID": {"workspace-a"}}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+base[4:]+"/ws", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := ws.WriteMessage(websocket.TextMessage, []byte(`{"version":2,"type":"subscribe_scope"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := ws.ReadMessage()
	if err != nil || string(data) != `{"version":2,"type":"subscribe_scope"}` {
		t.Fatalf("WebSocket tunnel: %q %v", data, err)
	}
	client.Close()
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("socket survived client close")
	}
}
