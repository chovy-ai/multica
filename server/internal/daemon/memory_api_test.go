package daemon

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const memoryTestAgent = "11111111-1111-4111-8111-111111111111"

func memoryTestDaemon(t *testing.T) *Daemon {
	t.Helper()
	d := New(Config{ProfileDir: t.TempDir(), LocalAPIToken: "desktop"}, slog.Default())
	t.Cleanup(func() { _ = d.memory.Close() })
	d.registerActiveRepoCheckoutTask("task", activeRepoCheckoutTask{AgentID: memoryTestAgent, EnvRoot: t.TempDir(), Source: "CHOV-117"})
	return d
}
func memoryTestCall(d *Daemon, method, path, token, body string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	d.registerMemoryRoutes(mux, true)
	r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}
func TestMemoryAPIAuthAndTaskIdentity(t *testing.T) {
	d := memoryTestDaemon(t)
	for _, tc := range []struct{ token, kind string }{{"", "no_credential"}, {"bad", "unknown_credential"}} {
		w := memoryTestCall(d, "GET", "/memory/index", tc.token, "")
		if w.Code != 401 || !strings.Contains(w.Body.String(), tc.kind) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := memoryTestCall(d, "PUT", "/memory/entry", "task", `{"path":"project/test","title":"Title","description":"Description","body":"Body","mode":"create","agent_id":"22222222-2222-4222-8222-222222222222"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "project/general/test.md") {
		t.Fatal(w.Code, w.Body.String())
	}
	for i := 0; i < 2; i++ {
		w = memoryTestCall(d, "POST", "/memory/receipts/claim", "task", "")
		var out struct{ Titles []string }
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Titles) != 1-i {
			t.Fatal(out)
		}
	}
	d.registerActiveRepoCheckoutTask("project", activeRepoCheckoutTask{AgentID: memoryTestAgent, EnvRoot: t.TempDir(), ProjectID: "22222222-2222-4222-8222-3f9a1c2b7d0e", ProjectTitle: "Multica"})
	w = memoryTestCall(d, "PUT", "/memory/entry", "project", `{"path":"project/another","title":"Title","description":"Description","body":"Body","mode":"create"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "multica-3f9a1c2b7d0e") {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestMemoryDesktopAPIConflictsAndLimits(t *testing.T) {
	d := memoryTestDaemon(t)
	path := "/local/agents/" + memoryTestAgent + "/memory"
	w := memoryTestCall(d, "GET", path, "bad", "")
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	w = memoryTestCall(d, "GET", path, "desktop", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"exists":false`) {
		t.Fatal(w.Body.String())
	}
	w = memoryTestCall(d, "PUT", "/memory/entry", "task", `{"path":"feedback/test","title":"Title","description":"Description","body":"Body","mode":"create"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = memoryTestCall(d, "PUT", path+"/entry", "desktop", `{"path":"feedback/test","title":"Edited","description":"Description","body":"Body","expected_updated_at":"2020-01-01T00:00:00Z"}`)
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"kind":"conflict"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = memoryTestCall(d, "PUT", path+"/entry", "desktop", `{"body":"`+strings.Repeat("a", 65536)+`"}`)
	if w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = memoryTestCall(d, "DELETE", path+"/entry?path=feedback/test", "desktop", "")
	var trash struct {
		TrashPath string `json:"trash_path"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &trash); err != nil {
		t.Fatal(err)
	}
	w = memoryTestCall(d, "GET", path+"/entry?trash_path="+trash.TrashPath, "desktop", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"body":"Body"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = memoryTestCall(d, "PUT", "/memory/entry", "task", `{"path":"feedback/test","title":"Title","description":"Description","body":"Body","mode":"create"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = memoryTestCall(d, "POST", path+"/restore", "desktop", fmt.Sprintf(`{"trash_path":%q}`, trash.TrashPath))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "restore_target_exists") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestMemoryBodyLimitIncludesTrailingWhitespace(t *testing.T) {
	d := memoryTestDaemon(t)
	path := "/local/agents/" + memoryTestAgent + "/memory/restore"
	w := memoryTestCall(d, "POST", path, "desktop", `{"trash_path":"missing"}`+strings.Repeat(" ", 65536))
	if w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
}
