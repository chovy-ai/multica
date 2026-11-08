package service

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
)

func TestIgnoredFilesKeepEvidenceAndExistenceThroughRunnerPersistence(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		for _, existed := range []bool{false, true} {
			name := provider + "/new"
			if existed {
				name = provider + "/existing"
			}
			t.Run(name, func(t *testing.T) {
				t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
				t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
				root := t.TempDir()
				if out, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
					t.Fatalf("git init: %v %s", err, out)
				}
				if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored.txt\n"), 0600); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(root, "ignored.txt")
				original := ""
				if existed {
					original = "pre-existing user bytes\n"
					if err := os.WriteFile(path, []byte(original), 0600); err != nil {
						t.Fatal(err)
					}
				}
				before := filechanges.Read(root, "ignored.txt")
				write := func() {
					t.Helper()
					if err := os.WriteFile(path, []byte("replacement\n"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				var f *runnerFixture
				var r *CodexRunner
				var server *fakeCodex
				if provider == "codex" {
					f, r, server = newCodexFixture(t, CodexSession{Cwd: root}, nil)
					defer r.Close(context.Background())
					codexSend(t, r, "t1")
					write()
					server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"overwrite","type":"fileChange","status":"completed","changes":[{"path":"ignored.txt","kind":{"type":"add"},"diff":"replacement\n"}]}}`)
					server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
				} else {
					f = newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
					f.runner.session.Fields["cwd"] = root
					defer f.runner.Close(context.Background())
					if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t1", RequestID: "request", MessageID: "message", Text: "write"}); err != nil {
						t.Fatal(err)
					}
					write()
					raw, _ := json.Marshal(map[string]any{"request_id": "request", "tool_id": "write", "path": "ignored.txt", "before": before, "after": filechanges.Read(root, "ignored.txt"), "reason": ""})
					f.adapter(0).handler(claude.Output{Type: "file_capture", Message: raw})
					f.adapter(0).emit(t, `{"type":"result","subtype":"success","is_error":false,"result":"done"}`)
				}
				f.turnEvents(t, "t1")
				page, err := f.store.ResourcePage(context.Background(), "conv-1", "")
				if err != nil {
					t.Fatal(err)
				}
				if provider == "codex" && existed {
					if len(page.Files) != 0 || page.Coverage != "partial" || page.Reason != "excluded" {
						t.Fatalf("unknown baseline must not invent file metadata: %+v", page)
					}
				} else {
					if len(page.Files) != 1 {
						t.Fatalf("resources: %+v", page)
					}
					detail, err := f.store.ChangeDetail(context.Background(), "conv-1", page.Files[0].ID, page.Revision)
					if err != nil || detail.File.Reason != "" || !detail.File.CurrentExists || detail.File.InitialExists != existed || detail.Before != original || detail.After != "replacement\n" || detail.Patch == "" {
						t.Fatalf("persisted evidence: %+v %v", detail, err)
					}
					wantDeleted := 0
					if existed {
						wantDeleted = 1
					}
					if detail.File.Kind == "deleted" || detail.File.Added == nil || *detail.File.Added != 1 || detail.File.Deleted == nil || *detail.File.Deleted != wantDeleted {
						t.Fatalf("existence and statistics: %+v", detail.File)
					}
				}
				if actual, err := os.ReadFile(path); err != nil || string(actual) != "replacement\n" {
					t.Fatalf("actual file: %q %v", actual, err)
				}
				if provider == "codex" && !existed {
					// The next turn cannot resample this now-existing ignored file.
					// It must invalidate, rather than keep serving, the first diff.
					codexSend(t, r, "t2")
					if err := os.WriteFile(path, []byte("second turn\n"), 0600); err != nil {
						t.Fatal(err)
					}
					server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"second","type":"fileChange","status":"completed","changes":[{"path":"ignored.txt","kind":{"type":"add"},"diff":"second turn\n"}]}}`)
					server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
					f.turnEvents(t, "t2")
					page, err = f.store.ResourcePage(context.Background(), "conv-1", "")
					if err != nil || len(page.Files) != 1 || page.Coverage != "partial" {
						t.Fatalf("later resources: %+v %v", page, err)
					}
					detail, err := f.store.ChangeDetail(context.Background(), "conv-1", page.Files[0].ID, page.Revision)
					if err != nil || detail.File.Reason == "" || !detail.File.CurrentExists || detail.File.Added != nil || detail.File.Deleted != nil || detail.Before != "" || detail.After != "" || detail.Patch != "" {
						t.Fatalf("earlier evidence survived an unsampled write: %+v %v", detail, err)
					}
				}
			})
		}
	}
}
