package localhost

import (
	"context"
	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"net/http"
	"testing"
)

func TestV2ResourcesRequireTheConversationScopeAndCurrentRevision(t *testing.T) {
	srv, svc := newV2Server(t)
	headers := v2Headers("user-1")
	status, body := v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "resource-session", "provider": "claude"}, headers)
	if status != http.StatusCreated {
		t.Fatalf("create %d %#v", status, body)
	}
	writer := svc.Store().NewWriter(store.WriterOptions{})
	defer writer.Close()
	before := filechanges.Snapshot{Hash: filechanges.Hash("")}
	after := filechanges.Snapshot{Exists: true, Content: "new\n", Hash: filechanges.Hash("new\n")}
	if _, err := writer.Submit(context.Background(), store.Batch{ConversationID: "resource-session", FileObservations: []filechanges.Observation{{OperationID: "one", Cwd: "/repo", Path: "a", Before: before, After: after}}}); err != nil {
		t.Fatal(err)
	}
	base := "/local/v2/sessions/resource-session"
	status, body = v2Do(t, srv, http.MethodGet, base+"/resources", nil, headers)
	if status != http.StatusOK {
		t.Fatalf("resources %d %#v", status, body)
	}
	files := body["files"].([]any)
	id := files[0].(map[string]any)["id"].(string)
	for _, tc := range []struct {
		suffix string
		status int
	}{
		{"/changes/" + id + "?revision=1", http.StatusOK}, {"/changes/" + id + "?revision=0", http.StatusConflict}, {"/changes/" + id, http.StatusBadRequest}, {"/changes/not-this-file?revision=1", http.StatusNotFound},
	} {
		status, body = v2Do(t, srv, http.MethodGet, base+tc.suffix, nil, headers)
		if status != tc.status {
			t.Fatalf("%s: %d %#v", tc.suffix, status, body)
		}
	}
	foreign := headers.Clone()
	foreign.Set(headerWorkspaceID, "other-workspace")
	for _, path := range []string{base + "/resources", base + "/changes/" + id + "?revision=1"} {
		status, body = v2Do(t, srv, http.MethodGet, path, nil, foreign)
		if status != http.StatusNotFound {
			t.Fatalf("cross-scope read %d %#v", status, body)
		}
	}
}
