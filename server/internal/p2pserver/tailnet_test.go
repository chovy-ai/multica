package p2pserver

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/types/key"

	"github.com/multica-ai/multica/server/internal/tailnetid"
)

// fakeHeadscale keeps users, keys and nodes in memory behind the REST paths
// Headscale serves.
type fakeHeadscale struct {
	mu     sync.Mutex
	users  []headscaleUser
	nodes  []HeadscaleNode
	keys   []map[string]any
	nextID int
}

func (f *fakeHeadscale) id() string { f.nextID++; return strconv.Itoa(f.nextID) }

func (f *fakeHeadscale) addNode(user, hostname string, nodeKey key.NodePublic) HeadscaleNode {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := HeadscaleNode{ID: f.id(), NodeKey: nodeKey.String(), Name: hostname}
	n.User.Name = user
	f.nodes = append(f.nodes, n)
	return n
}

func (f *fakeHeadscale) nodeNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var names []string
	for _, n := range f.nodes {
		names = append(names, n.Name)
	}
	return names
}

func (f *fakeHeadscale) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer hs-key" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/user":
		var out []headscaleUser
		for _, u := range f.users {
			if u.Name == r.URL.Query().Get("name") {
				out = append(out, u)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"users": out})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/user":
		var req struct{ Name string }
		json.NewDecoder(r.Body).Decode(&req)
		u := headscaleUser{ID: f.id(), Name: req.Name}
		f.users = append(f.users, u)
		json.NewEncoder(w).Encode(map[string]any{"user": u})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/preauthkey":
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		f.keys = append(f.keys, req)
		json.NewEncoder(w).Encode(map[string]any{"preAuthKey": map[string]any{"key": "authkey-" + f.id()}})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/node":
		var out []HeadscaleNode
		for _, n := range f.nodes {
			if user := r.URL.Query().Get("user"); user == "" || n.User.Name == user {
				out = append(out, n)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"nodes": out})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/node/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/node/")
		for i, n := range f.nodes {
			if n.ID == id {
				f.nodes = append(f.nodes[:i], f.nodes[i+1:]...)
				break
			}
		}
		w.Write([]byte("{}"))
	default:
		http.NotFound(w, r)
	}
}

func withTailnet(t *testing.T, h *harness) *fakeHeadscale {
	t.Helper()
	hs := &fakeHeadscale{}
	srv := httptest.NewServer(hs)
	t.Cleanup(srv.Close)
	h.srv.Tailnet = &Tailnet{Headscale: &Headscale{BaseURL: srv.URL, APIKey: "hs-key"}, ControlURL: "http://control.example:8091"}
	return hs
}

func TestTailnetCredentialsRequireTheAccountsRegisteredDevice(t *testing.T) {
	h := newHarness(t)
	keyA, idA := newKey(t)
	keyB, idB := newKey(t)
	h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", PublicKey: keyA})
	h.do(t, http.MethodPost, "/v1/devices", "tok-bob", registerRequest{DaemonID: "m1", PublicKey: keyB})

	if code, _ := h.do(t, http.MethodPost, "/v1/tailnet", "tok-alice", tailnetRequest{PeerID: idA.String()}); code != http.StatusNotFound {
		t.Fatalf("without a control server = %d, want 404", code)
	}
	hs := withTailnet(t, h)

	_, unknown := newKey(t)
	for _, id := range []string{unknown.String(), idB.String()} {
		if code, body := h.do(t, http.MethodPost, "/v1/tailnet", "tok-alice", tailnetRequest{PeerID: id}); code != http.StatusForbidden {
			t.Fatalf("credentials for %s = %d %s, want 403", id, code, body)
		}
	}

	for range 2 {
		code, body := h.do(t, http.MethodPost, "/v1/tailnet", "tok-alice", tailnetRequest{PeerID: idA.String()})
		if code != http.StatusOK {
			t.Fatalf("credentials = %d %s", code, body)
		}
		var resp map[string]string
		json.Unmarshal(body, &resp)
		if resp["control_url"] != "http://control.example:8091" || !strings.HasPrefix(resp["auth_key"], "authkey-") || resp["hostname"] != tailnetid.Hostname(idA.String()) {
			t.Fatalf("credentials = %v", resp)
		}
	}
	if len(hs.users) != 1 || hs.users[0].Name != "u-user-alice" {
		t.Fatalf("headscale users = %+v, want one per account", hs.users)
	}
	for _, k := range hs.keys {
		expires, _ := time.Parse(time.RFC3339, k["expiration"].(string))
		if k["reusable"] != false || k["ephemeral"] != false || k["user"] != hs.users[0].ID || expires.After(h.clock.Add(tailnetKeyTTL)) {
			t.Fatalf("pre-auth key request = %v", k)
		}
	}
}

func TestDepartedDevicesLeaveTheTailnet(t *testing.T) {
	h := newHarness(t)
	hs := withTailnet(t, h)
	keyA, idA := newKey(t)
	keyW, idW := newKey(t)
	h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", PublicKey: keyA})
	h.do(t, http.MethodPost, "/v1/devices", "tok-alice", registerRequest{DaemonID: "m1", Profile: "work", PublicKey: keyW})
	hs.addNode("u-user-alice", tailnetid.Hostname(idA.String()), key.NewNode().Public())
	hs.addNode("u-user-alice", tailnetid.Hostname(idW.String()), key.NewNode().Public())
	hs.addNode("u-user-alice", "mstale", key.NewNode().Public())
	hs.addNode("operator", "unmanaged", key.NewNode().Public())

	if code, _ := h.do(t, http.MethodDelete, "/v1/devices?daemon_id=m1&profile=work", "tok-alice", nil); code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	if n, err := h.srv.pruneTailnet(context.Background()); err != nil || n != 1 {
		t.Fatalf("prune = %d, %v", n, err)
	}
	if got := strings.Join(hs.nodeNames(), ","); got != tailnetid.Hostname(idA.String())+",unmanaged" {
		t.Fatalf("nodes = %s", got)
	}
}

func TestDERPAdmitsOnlyNodesTheControlServerKnows(t *testing.T) {
	hs := &fakeHeadscale{}
	srv := httptest.NewServer(hs)
	defer srv.Close()
	tn := &Tailnet{Headscale: &Headscale{BaseURL: srv.URL, APIKey: "hs-key"}}
	known := key.NewNode().Public()
	hs.addNode("u-user-alice", "m1", known)
	if ok, err := tn.Admit(context.Background(), known); err != nil || !ok {
		t.Fatalf("known node = %v, %v", ok, err)
	}
	if ok, err := tn.Admit(context.Background(), key.NewNode().Public()); err != nil || ok {
		t.Fatalf("unknown node = %v, %v", ok, err)
	}
	// A node registered after the last fetch is admitted once the short refresh passes.
	later := key.NewNode().Public()
	hs.addNode("u-user-alice", "m2", later)
	tn.mu.Lock()
	tn.fetchedAt = time.Now().Add(-tailnetAdmitRefresh)
	tn.mu.Unlock()
	if ok, err := tn.Admit(context.Background(), later); err != nil || !ok {
		t.Fatalf("new node = %v, %v", ok, err)
	}
}

func TestDERPPinsOneCertificateAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	cfg := DERPConfig{
		PublicIP:   net.ParseIP("127.0.0.1"),
		Listen:     "127.0.0.1:0",
		STUNListen: "127.0.0.1:0",
		KeyPath:    filepath.Join(dir, "derp.key"),
		CertPath:   filepath.Join(dir, "derp.pem"),
		Logger:     discardLogger,
	}
	first, err := StartDERP(cfg)
	if err != nil {
		t.Fatal(err)
	}
	node := first.Map().Regions[derpRegionID].Nodes[0]
	first.Close()

	second, err := StartDERP(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	m := second.Map()
	again := m.Regions[derpRegionID].Nodes[0]
	if !m.OmitDefaultRegions || len(m.Regions) != 1 {
		t.Fatalf("map = %+v, want only this region", m)
	}
	if again.CertName != node.CertName || !strings.HasPrefix(again.CertName, "sha256-raw:") || again.IPv4 != "127.0.0.1" {
		t.Fatalf("node = %+v, first = %+v", again, node)
	}

	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", again.DERPPort), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	sum := sha256.Sum256(conn.ConnectionState().PeerCertificates[0].Raw)
	if got := fmt.Sprintf("sha256-raw:%x", sum); got != again.CertName {
		t.Fatalf("served certificate %s, map pins %s", got, again.CertName)
	}
}

func TestDERPMapIsServedForTheControlServer(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.raw(t, http.MethodGet, "/v1/tailnet/derpmap", "", nil); code != http.StatusNotFound {
		t.Fatalf("without a relay = %d", code)
	}
	withTailnet(t, h)
	derp, err := StartDERP(DERPConfig{
		PublicIP: net.ParseIP("127.0.0.1"), Listen: "127.0.0.1:0", STUNListen: "127.0.0.1:0",
		KeyPath: filepath.Join(t.TempDir(), "k"), CertPath: filepath.Join(t.TempDir(), "c"), Logger: discardLogger,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer derp.Close()
	h.srv.Tailnet.DERP = derp
	code, body := h.raw(t, http.MethodGet, "/v1/tailnet/derpmap", "", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"omitDefaultRegions":true`) {
		t.Fatalf("derp map = %d %s", code, body)
	}
}
