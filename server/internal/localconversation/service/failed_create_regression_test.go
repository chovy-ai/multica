package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestVerificationFailedCreateIsAbsentFromResources(t *testing.T) {
	f, r, server := newCodexFixture(t, CodexSession{Cwd: t.TempDir()}, nil)
	defer r.Close(context.Background())
	codexSend(t, r, "t1")
	server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"failed-patch","type":"fileChange","status":"failed","changes":[{"path":"never-created.ts","kind":{"type":"add"},"diff":"new\n"}]}}`)
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
	f.turnEvents(t, "t1")
	page, err := f.store.ResourcePage(context.Background(), "conv-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Files) != 0 {
		t.Fatalf("failed tool wrote no files but resource page contains phantom change: %#v", page)
	}
	exportResourceEvidence(t, "no-write", f.store)
}

func TestCodexRunnerNoWriteOutcomesStayOutOfResources(t *testing.T) {
	for _, tc := range []struct {
		name, kind, patch, status, turnStatus string
		exists                                bool
	}{
		{name: "failed add", kind: "add", patch: "new\n", status: "failed", turnStatus: "completed"},
		{name: "failed update", kind: "update", patch: "@@ -1 +1 @@\n-A\n+B\n", status: "failed", turnStatus: "completed", exists: true},
		{name: "cancelled add", kind: "add", patch: "new\n", status: "cancelled", turnStatus: "interrupted"},
		{name: "cancelled update", kind: "update", patch: "@@ -1 +1 @@\n-A\n+B\n", status: "cancelled", turnStatus: "interrupted", exists: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if tc.exists {
				if err := os.WriteFile(filepath.Join(root, "source.ts"), []byte("A\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			f, r, server := newCodexFixture(t, CodexSession{Cwd: root}, nil)
			defer r.Close(context.Background())
			codexSend(t, r, "t1")
			payload, _ := json.Marshal(map[string]any{"threadId": "th-1", "turnId": "tu-1", "item": map[string]any{"id": "no-write", "type": "fileChange", "status": tc.status, "changes": []any{map[string]any{"path": "source.ts", "kind": map[string]string{"type": tc.kind}, "diff": tc.patch}}}})
			server.notify(t, "item/completed", string(payload))
			server.notify(t, "turn/completed", fmt.Sprintf(`{"threadId":"th-1","turn":{"id":"tu-1","status":%q}}`, tc.turnStatus))
			f.turnEvents(t, "t1")
			page, err := f.store.ResourcePage(context.Background(), "conv-1", "")
			if err != nil || len(page.Files) != 0 || page.Coverage != "complete" {
				t.Fatalf("no-write ledger %#v %v", page, err)
			}
		})
	}
}

func TestCodexFailedMultiFilePatchKeepsOnlyTheWrittenFile(t *testing.T) {
	root := t.TempDir()
	f, r, server := newCodexFixture(t, CodexSession{Cwd: root}, nil)
	defer r.Close(context.Background())
	codexSend(t, r, "t1")
	if err := os.WriteFile(filepath.Join(root, "written.ts"), []byte("new\n"), 0600); err != nil {
		t.Fatal(err)
	}
	server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"partial","type":"fileChange","status":"failed","changes":[{"path":"written.ts","kind":{"type":"add"},"diff":"new\n"},{"path":"never-created.ts","kind":{"type":"add"},"diff":"new\n"}]}}`)
	server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"failed"}}`)
	f.turnEvents(t, "t1")
	page, err := f.store.ResourcePage(context.Background(), "conv-1", "")
	if err != nil || len(page.Files) != 1 || page.Files[0].Path != "written.ts" || page.Files[0].Reason != "" {
		t.Fatalf("partial tool ledger %#v %v", page, err)
	}
	detail, err := f.store.ChangeDetail(context.Background(), "conv-1", page.Files[0].ID, page.Revision)
	if err != nil || detail.After != "new\n" || detail.Before != "" {
		t.Fatalf("partial tool detail %#v %v", detail, err)
	}
}
