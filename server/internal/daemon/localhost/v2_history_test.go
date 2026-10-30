package localhost

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestV2HistoryPagesWithoutCrossingWorkspace(t *testing.T) {
	t.Parallel()
	srv, svc := newV2Server(t)
	h := v2Headers("user-1")
	status, _ := v2Do(t, srv, http.MethodPost, "/local/v2/sessions", map[string]any{"id": "history", "provider": "claude"}, h)
	if status != http.StatusCreated {
		t.Fatal(status)
	}
	writer := svc.Store().NewWriter(store.WriterOptions{})
	defer writer.Close()
	for i := 0; i < 45; i++ {
		id := fmt.Sprintf("history-%d", i)
		_, err := writer.Submit(context.Background(), store.Batch{ConversationID: "history", StartTurn: &store.NewTurn{ID: id, StartedAt: time.Now()}, Messages: []store.NewMessage{{ID: "message-" + id, TurnID: id, Role: "user", Content: id, CreatedAt: time.Now()}}, CompleteTurn: &store.TurnCompletion{TurnID: id, Status: "completed", CompletedAt: time.Now()}})
		if err != nil {
			t.Fatal(err)
		}
	}
	_, snap := v2Do(t, srv, http.MethodGet, "/local/v2/sessions/history/snapshot", nil, h)
	if len(snap["turns"].([]any)) != 20 || snap["has_older_turns"] != true {
		t.Fatalf("snapshot = %v", snap)
	}
	status, page := v2Do(t, srv, http.MethodGet, "/local/v2/sessions/history/history?before_index=25", nil, h)
	turns := page["turns"].([]any)
	if status != http.StatusOK || len(turns) != 20 || turns[0].(map[string]any)["turn_index"] != float64(5) || page["has_older_turns"] != true {
		t.Fatalf("page = %d %v", status, page)
	}
	_, last := v2Do(t, srv, http.MethodGet, "/local/v2/sessions/history/history?before_index=5", nil, h)
	if len(last["turns"].([]any)) != 5 || last["has_older_turns"] != false {
		t.Fatalf("last = %v", last)
	}
	for _, cursor := range []string{"", "-1", "invalid", "46"} {
		status, _ := v2Do(t, srv, http.MethodGet, "/local/v2/sessions/history/history?before_index="+cursor, nil, h)
		if status != http.StatusBadRequest {
			t.Fatalf("cursor %q = %d", cursor, status)
		}
	}
	other := h.Clone()
	other.Set(headerWorkspaceID, "ws-2")
	status, _ = v2Do(t, srv, http.MethodGet, "/local/v2/sessions/history/history?before_index=25", nil, other)
	if status != http.StatusNotFound {
		t.Fatalf("other workspace = %d", status)
	}
}

func TestV2AttachmentMetadataIsScoped(t *testing.T) {
	t.Parallel()
	srv, svc := newV2Server(t)
	ctx := context.Background()
	scope, err := svc.Store().EnsureScope(ctx, store.Scope{APIOrigin: "https://api.multica.ai", UserID: "user-1", WorkspaceID: "ws-1"})
	if err != nil {
		t.Fatal(err)
	}
	attachment, err := svc.Upload(ctx, scope, "guide.pdf", "application/pdf", strings.NewReader("%PDF-test"))
	if err != nil {
		t.Fatal(err)
	}
	path := "/local/v2/attachments/" + attachment.ID + "/metadata"
	status, metadata := v2Do(t, srv, http.MethodGet, path, nil, v2Headers("user-1"))
	if status != http.StatusOK || metadata["name"] != "guide.pdf" || metadata["mime_type"] != "application/pdf" {
		t.Fatalf("metadata = %d %v", status, metadata)
	}
	other := v2Headers("user-1")
	other.Set(headerWorkspaceID, "ws-2")
	status, _ = v2Do(t, srv, http.MethodGet, path, nil, other)
	if status != http.StatusNotFound {
		t.Fatalf("other workspace = %d", status)
	}
}
