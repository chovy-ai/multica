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

// Optional test artifacts let browser tests render the actual persisted responses.
func exportResourceEvidence(t *testing.T, name string, s *store.Store) {
	t.Helper()
	dir := os.Getenv("MULTICA_RESOURCE_EVIDENCE_DIR")
	if dir == "" {
		return
	}
	ctx := context.Background()
	page, err := s.ResourcePage(ctx, "conv-1", "")
	if err != nil {
		t.Fatal(err)
	}
	details := map[string]store.ChangeDetail{}
	for _, file := range page.Files {
		detail, err := s.ChangeDetail(ctx, "conv-1", file.ID, page.Revision)
		if err != nil {
			t.Fatal(err)
		}
		details[file.ID] = detail
	}
	raw, err := json.Marshal(map[string]any{"page": page, "details": details})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, name+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestMultiFileRunnerEvidenceCanBeReadWithoutTranscriptHistory(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "edited.ts"), []byte("user\nA\n"), 0600); err != nil {
				t.Fatal(err)
			}
			beforeEdited := filechanges.Read(root, "edited.ts")
			beforeCreated := filechanges.Read(root, "created.ts")
			write := func() {
				t.Helper()
				for name, content := range map[string]string{"edited.ts": "user\nB\n", "created.ts": "new\n"} {
					if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			var f *runnerFixture
			if provider == "codex" {
				var r *CodexRunner
				var server *fakeCodex
				f, r, server = newCodexFixture(t, CodexSession{Cwd: root}, nil)
				defer r.Close(context.Background())
				codexSend(t, r, "t1")
				write()
				server.notify(t, "item/completed", `{"threadId":"th-1","turnId":"tu-1","item":{"id":"multi","type":"fileChange","status":"completed","changes":[{"path":"edited.ts","kind":{"type":"update"},"diff":"@@ -1,2 +1,2 @@\n user\n-A\n+B\n"},{"path":"created.ts","kind":{"type":"add"},"diff":"new\n"}]}}`)
				server.notify(t, "turn/completed", `{"threadId":"th-1","turn":{"id":"tu-1","status":"completed"}}`)
			} else {
				f = newRunnerFixture(t, NewLimiter(MaxRunningTurns), nil)
				f.runner.session.Fields["cwd"] = root
				defer f.runner.Close(context.Background())
				if err := f.runner.Send(context.Background(), SendRequest{TurnID: "t1", RequestID: "multi", MessageID: "message", Text: "edit files"}); err != nil {
					t.Fatal(err)
				}
				write()
				for path, before := range map[string]filechanges.Snapshot{"edited.ts": beforeEdited, "created.ts": beforeCreated} {
					raw, _ := json.Marshal(map[string]any{"request_id": "multi", "tool_id": path, "path": path, "before": before, "after": filechanges.Read(root, path), "reason": ""})
					f.adapter(0).handler(claude.Output{Type: "file_capture", Message: raw})
				}
				f.adapter(0).emit(t, `{"type":"result","subtype":"success","is_error":false,"result":"done"}`)
			}
			f.turnEvents(t, "t1")
			page, err := f.store.ResourcePage(context.Background(), "conv-1", "")
			if err != nil || len(page.Files) != 2 {
				t.Fatalf("multi-file %#v %v", page, err)
			}
			for _, file := range page.Files {
				d, err := f.store.ChangeDetail(context.Background(), "conv-1", file.ID, page.Revision)
				if err != nil || file.Reason != "" || d.Patch == "" {
					t.Fatalf("evidence %#v %v", d, err)
				}
			}
			exportResourceEvidence(t, provider, f.store)
		})
	}
}

func TestForkAndSideKeepIndependentResourceLedgers(t *testing.T) {
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "isolated.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	f.runTurn(t, "r1", "native-turn")
	snapshot := func(content string) filechanges.Snapshot {
		return filechanges.Snapshot{Exists: true, Content: content, Hash: filechanges.Hash(content)}
	}
	write := func(id, op, before, after string) {
		t.Helper()
		_, err := f.svc.writer.Submit(ctx, store.Batch{ConversationID: id, FileObservations: []filechanges.Observation{{OperationID: op, Cwd: "/repo", Path: "shared.ts", Before: snapshot(before), After: snapshot(after)}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	write("conv-1", "parent", "A", "B")
	f.mu.Lock()
	f.reply = func(_ *fakeAdapter, typ string) (json.RawMessage, error) {
		if typ == "fork_session" {
			return json.RawMessage(`{"session_id":"native-fork"}`), nil
		}
		return json.RawMessage(`{}`), nil
	}
	f.mu.Unlock()
	fork, err := f.svc.Fork(ctx, ForkCommand{ScopeID: f.scopeID, SourceID: "conv-1", TurnID: "turn-r1", RequestID: "fork"})
	if err != nil {
		t.Fatal(err)
	}
	side, err := f.svc.CreateSide(ctx, SideCommand{ScopeID: f.scopeID, SourceID: "conv-1", TurnID: "turn-r1", RequestID: "side"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{fork.ID, side.ID} {
		p, err := f.svc.ResourcePage(ctx, f.scopeID, id, "")
		if err != nil || len(p.Files) != 0 {
			t.Fatalf("inherited resources %#v %v", p, err)
		}
		write(id, id, "B", "C")
	}
	for _, tc := range []struct{ id, before, after string }{{"conv-1", "A", "B"}, {fork.ID, "B", "C"}, {side.ID, "B", "C"}} {
		p, err := f.svc.ResourcePage(ctx, f.scopeID, tc.id, "")
		if err != nil || len(p.Files) != 1 {
			t.Fatalf("isolated list %#v %v", p, err)
		}
		d, err := f.svc.ChangeDetail(ctx, f.scopeID, tc.id, p.Files[0].ID, p.Revision)
		if err != nil || d.Before != tc.before || d.After != tc.after {
			t.Fatalf("isolated detail %#v %v", d, err)
		}
	}
}
