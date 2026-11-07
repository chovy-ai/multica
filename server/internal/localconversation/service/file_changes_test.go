package service

import (
	"context"
	"encoding/json"
	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"os"
	"path/filepath"
	"testing"
)

func assertRunnerResource(t *testing.T, s *store.Store) {
	t.Helper()
	ctx := context.Background()
	page, err := s.ResourcePage(ctx, "conv-1", "")
	if err != nil || len(page.Files) != 1 {
		t.Fatalf("resources %#v %v", page, err)
	}
	detail, err := s.ChangeDetail(ctx, "conv-1", page.Files[0].ID, page.Revision)
	if err != nil || detail.File.Reason != "" || detail.Before != "user\nA\n" || detail.After != "user\nB\n" || *detail.File.Added != 1 || *detail.File.Deleted != 1 {
		t.Fatalf("detail %#v %v", detail, err)
	}
}

func TestCodexRunnerCommitsVerifiedFileEvidenceWithItsTurn(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.ts")
	if err := os.WriteFile(path, []byte("user\nA\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f, r, server := newCodexFixture(t, CodexSession{Cwd: root}, nil)
	defer r.Close(context.Background())
	codexSend(t, r, "t1")
	if err := os.WriteFile(path, []byte("user\nB\n"), 0600); err != nil {
		t.Fatal(err)
	}
	server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"patch","type":"fileChange","status":"completed","changes":[{"path":"a.ts","kind":{"type":"update"},"diff":"@@ -1,2 +1,2 @@\n user\n-A\n+B\n"}]}}`)
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"failed","error":{"message":"later failure"}}}`)
	f.turnEvents(t, "t1")
	assertRunnerResource(t, f.store)
}

func TestClaudeRunnerBindsAdapterEvidenceToTheOriginatingTurn(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.ts")
	if err := os.WriteFile(path, []byte("user\nA\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f := newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
	f.runner.session.Fields["cwd"] = root
	defer f.runner.Close(context.Background())
	if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t1", RequestID: "request", MessageID: "message", Text: "edit"}); err != nil {
		t.Fatal(err)
	}
	before := filechanges.Read(root, "a.ts")
	if err := os.WriteFile(path, []byte("user\nB\n"), 0600); err != nil {
		t.Fatal(err)
	}
	after := filechanges.Read(root, "a.ts")
	raw, _ := json.Marshal(map[string]any{"request_id": "request", "tool_id": "tool", "path": "a.ts", "before": before, "after": after, "reason": ""})
	f.adapter(0).handler(claude.Output{Type: "file_capture", Message: raw})
	f.adapter(0).emit(t, `{"type":"result","subtype":"success","is_error":false,"result":"done"}`)
	f.turnEvents(t, "t1")
	assertRunnerResource(t, f.store)
}
