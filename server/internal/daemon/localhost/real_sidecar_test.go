package localhost

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/runtimeinstance"
)

// TestRealSidecarRoundTrip drives the packaged TypeScript sidecar through the
// real daemon API. It needs a built Desktop and runs only on request:
//
//	MULTICA_LOCALHOST_SIDECAR_E2E=1 \
//	MULTICA_LOCALHOST_ELECTRON=<electron binary> \
//	MULTICA_LOCALHOST_ENTRY=<apps/desktop/out/main/local-conversation-host.js> \
//	go test ./internal/daemon/localhost -run TestRealSidecarRoundTrip -v
func TestRealSidecarRoundTrip(t *testing.T) {
	if os.Getenv("MULTICA_LOCALHOST_SIDECAR_E2E") != "1" {
		t.Skip("set MULTICA_LOCALHOST_SIDECAR_E2E=1 to run against a built sidecar")
	}
	electron, entry := os.Getenv("MULTICA_LOCALHOST_ELECTRON"), os.Getenv("MULTICA_LOCALHOST_ENTRY")
	if electron == "" || entry == "" {
		t.Fatal("MULTICA_LOCALHOST_ELECTRON and MULTICA_LOCALHOST_ENTRY are required")
	}
	h := newHarness(t, true)
	// Development registers absolute paths; it must not depend on a packaged
	// .app layout or on a manifest inherited from the launching shell.
	cliPath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	store := runtimeinstance.New(t.TempDir())
	launch := runtimeinstance.Launch{SchemaVersion: 1, InstanceID: "desktop", OwnerID: "11111111111111111111111111111111", Kind: "development", AppPath: filepath.Dir(entry), CLIPath: cliPath, ElectronPath: electron, EntryPath: entry, CLIVersion: "test", CLICommit: "abcdef123", Profile: runtimeinstance.ProfileName, APIURL: "https://api.example", ProtocolVersion: 2}
	if err := store.PublishLaunch(launch); err != nil {
		t.Fatal(err)
	}
	registered, err := store.ReadLaunch("desktop")
	if err != nil {
		t.Fatal(err)
	}
	if err := registered.ValidateExecutable(cliPath); err != nil {
		t.Fatal(err)
	}
	h.srv.sup.cmd = SidecarCommand(Sidecar{ProtocolVersion: registered.ProtocolVersion, Electron: registered.ElectronPath, Entry: registered.EntryPath})
	h.signIn(scope.UserID)
	if err := os.WriteFile(filepath.Join(h.profile, "config.json"), []byte(`{"token":"","server_url":"https://api.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	c := h.dial()
	h.session(c)
	if _, err := c.call(t, "subscribe", map[string]any{"since": ""}); err != nil {
		t.Fatal(err)
	}
	raw, err := c.call(t, "request", map[string]any{"scope": scope, "method": "list", "params": map[string]any{}})
	if err != nil || string(raw) != "[]" {
		t.Fatalf("list = %s, %v", raw, err)
	}
	created, err := c.call(t, "request", map[string]any{"scope": scope, "method": "create", "params": map[string]any{"provider": "codex", "title": "Round trip"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var conversation struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(created, &conversation)
	c.next(t, "event")

	body := bytes.Repeat([]byte("sidecar-bytes "), 4096)
	req, _ := http.NewRequest(http.MethodPost, fileURL(h, "/local/v1/files"), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("X-File-Name", url.PathEscape("round trip.txt"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var up struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&up)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || up.ID == "" {
		t.Fatalf("upload: %d %+v", resp.StatusCode, up)
	}
	get, _ := http.NewRequest(http.MethodGet, fileURL(h, "/local/v1/files/"+up.ID), nil)
	get.Header.Set("Authorization", "Bearer "+testToken)
	get.Header.Set("Range", "bytes=0-13")
	resp, err = http.DefaultClient.Do(get)
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || string(part) != "sidecar-bytes " {
		t.Fatalf("range read: %d %q", resp.StatusCode, part)
	}
	for _, method := range []string{"fileRead", "remoteUpdate"} {
		if _, err := c.call(t, "request", map[string]any{"scope": scope, "method": method, "params": map[string]any{"id": up.ID}}); appCode(err) != "method_not_allowed" {
			t.Fatalf("%s from Desktop: %v", method, err)
		}
	}
	t.Logf("conversation %s, attachment %s", conversation.ID, up.ID)
}
