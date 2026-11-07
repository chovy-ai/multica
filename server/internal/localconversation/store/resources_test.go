package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/filechanges"
)

func snap(text string, exists bool) filechanges.Snapshot {
	return filechanges.Snapshot{Content: text, Exists: exists, Hash: filechanges.Hash(text)}
}
func TestResourcesNetChangesAtomicityReplayAndIsolation(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	createConversation(t, s, "b")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	write := func(op, before, after string, reason string) {
		t.Helper()
		_, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: op, Cwd: "/repo", Path: "a.ts", Before: snap(before, true), After: snap(after, true), Reason: reason}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	write("one", "user\nA\n", "user\nB\n", "")
	write("two", "user\nB\n", "user\nC\n", "")
	page, err := s.ResourcePage(ctx, "a", "")
	if err != nil || len(page.Files) != 1 {
		t.Fatalf("page %#v %v", page, err)
	}
	detail, err := s.ChangeDetail(ctx, "a", page.Files[0].ID, page.Revision)
	if err != nil || detail.Before != "user\nA\n" || detail.After != "user\nC\n" || *detail.File.Added != 1 || *detail.File.Deleted != 1 {
		t.Fatalf("net %#v %v", detail, err)
	}
	write("two", "user\nB\n", "user\nC\n", "")
	same, _ := s.ResourcePage(ctx, "a", "")
	if same.Revision != page.Revision {
		t.Fatal("duplicate changed revision")
	}
	if _, err := s.ChangeDetail(ctx, "b", detail.File.ID, page.Revision); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross conversation %v", err)
	}
	write("three", "user\nC\n", "user\nA\n", "")
	page, _ = s.ResourcePage(ctx, "a", "")
	if len(page.Files) != 0 {
		t.Fatal("restored file still counted")
	}
	write("four", "user\nA\n", "other\n", "uncertain")
	page, _ = s.ResourcePage(ctx, "a", "")
	d, err := s.ChangeDetail(ctx, "a", detail.File.ID, page.Revision)
	if err != nil || d.Patch != "" || d.Before != "" || d.After != "" || d.File.Added != nil {
		t.Fatalf("uncertain bytes exposed: %#v %v", d, err)
	}
	if _, err = s.ChangeDetail(ctx, "a", detail.File.ID, page.Revision-1); !errors.Is(err, ErrResourceRevision) {
		t.Fatal(err)
	}
	// Tool output and evidence are rolled back together.
	_, err = w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: "rollback", Cwd: "/repo", Path: "x", After: snap("x", true)}}, Events: []NewEvent{event("", "", "item.completed", true, `invalid`)}})
	if err == nil {
		t.Fatal("invalid batch committed")
	}
	after, _ := s.ResourcePage(ctx, "a", "")
	if after.Revision != page.Revision {
		t.Fatal("evidence survived failed event commit")
	}
}

func TestResourcePaginationRetainsEarlyChangesAndRejectsChangedCursor(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	var observations []filechanges.Observation
	for i := 0; i < 203; i++ {
		observations = append(observations, filechanges.Observation{OperationID: fmt.Sprint(i), Cwd: "/repo", Path: fmt.Sprintf("%03d", i), Before: snap("", false), After: snap("new", true)})
	}
	if _, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: observations}); err != nil {
		t.Fatal(err)
	}
	first, err := s.ResourcePage(ctx, "a", "")
	if err != nil || len(first.Files) != 200 || first.NextCursor == nil {
		t.Fatalf("first %d %v", len(first.Files), err)
	}
	second, err := s.ResourcePage(ctx, "a", *first.NextCursor)
	if err != nil || len(second.Files) != 3 || second.NextCursor != nil {
		t.Fatalf("second %d %v", len(second.Files), err)
	}
	if _, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: "new", Cwd: "/repo", Path: "new", Before: snap("", false), After: snap("x", true)}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResourcePage(ctx, "a", *first.NextCursor); !errors.Is(err, ErrResourceRevision) {
		t.Fatal("stale cursor accepted")
	}
}

func TestIncompleteCaptureIsVisibleUntilItsOrderedCompletion(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	for _, phase := range []string{"start", "end"} {
		if _, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: "capture-" + phase + ":turn"}}}); err != nil {
			t.Fatal(err)
		}
		p, err := s.ResourcePage(ctx, "a", "")
		if err != nil {
			t.Fatal(err)
		}
		if phase == "start" && p.Coverage != "partial" {
			t.Fatal("unfinished capture reported complete")
		}
		if phase == "end" && p.Coverage != "complete" {
			t.Fatalf("completed capture %#v", p)
		}
	}
}

func TestResourceRenameIdentitySurvivesSourceRecreationAndReturn(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	submit := func(o filechanges.Observation) {
		t.Helper()
		o.Cwd = "/repo"
		if _, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{o}}); err != nil {
			t.Fatal(err)
		}
	}
	submit(filechanges.Observation{OperationID: "move", Path: "old", MovePath: "new", Before: snap("original", true), After: snap("original", true)})
	submit(filechanges.Observation{OperationID: "create", Path: "old", Before: snap("", false), After: snap("new file", true)})
	page, err := s.ResourcePage(ctx, "a", "")
	if err != nil || len(page.Files) != 2 {
		t.Fatalf("rename identity overwritten %#v %v", page, err)
	}
	seen := map[string]bool{}
	for _, f := range page.Files {
		seen[f.Kind] = true
	}
	if !seen["renamed"] || !seen["added"] {
		t.Fatal(page.Files)
	}
	// Moving away and back without content changes is a net no-op.
	createConversation(t, s, "b")
	for _, o := range []filechanges.Observation{{OperationID: "out", Path: "old", MovePath: "new", Before: snap("same", true), After: snap("same", true)}, {OperationID: "back", Path: "new", MovePath: "old", Before: snap("same", true), After: snap("same", true)}} {
		o.Cwd = "/repo"
		if _, err := w.Submit(ctx, Batch{ConversationID: "b", FileObservations: []filechanges.Observation{o}}); err != nil {
			t.Fatal(err)
		}
	}
	page, err = s.ResourcePage(ctx, "b", "")
	if err != nil || len(page.Files) != 0 {
		t.Fatalf("net rename %#v %v", page, err)
	}
}

func TestResourcesUpgradeV7AndSurviveReopenWithoutBackfillingHistory(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := schemaVersions()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range versions[:7] {
		ddl, err := schemaFS.ReadFile(v.file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(ddl)); err != nil {
			t.Fatal(err)
		}
	}
	legacy := &Store{path: path, write: db, read: db}
	createConversation(t, legacy, "history")
	if _, err = db.Exec("UPDATE conversation SET turn_count=2 WHERE id='history'"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("PRAGMA user_version=7"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path + ".v7.bak"); err != nil {
		t.Fatal("upgrade backup missing", err)
	}
	p, err := s.ResourcePage(ctx, "history", "")
	if err != nil || p.Coverage != "missing_baseline" || len(p.Files) != 0 {
		t.Fatalf("backfilled history %#v %v", p, err)
	}
	w := s.NewWriter(WriterOptions{})
	_, err = w.Submit(ctx, Batch{ConversationID: "history", FileObservations: []filechanges.Observation{{OperationID: "write", Cwd: "/repo", Path: "a", Before: snap("a", true), After: snap("b", true)}, {OperationID: "capture-start:interrupted"}}})
	if err != nil {
		t.Fatal(err)
	}
	w.Close()
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	p, err = reopened.ResourcePage(ctx, "history", "")
	if err != nil || len(p.Files) != 1 || p.Coverage != "partial" {
		t.Fatalf("restart %#v %v", p, err)
	}
	detail, err := reopened.ChangeDetail(ctx, "history", p.Files[0].ID, p.Revision)
	if err != nil || detail.Before != "a" || detail.After != "b" {
		t.Fatalf("restart lost evidence %#v %v", detail, err)
	}
}

func TestResourceCountsIncludeSourceLinesThatLookLikePatchHeaders(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	if _, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: "one", Cwd: "/repo", Path: "a", Before: snap("--old\n", true), After: snap("++new\n", true)}}}); err != nil {
		t.Fatal(err)
	}
	p, err := s.ResourcePage(ctx, "a", "")
	if err != nil || len(p.Files) != 1 || p.Files[0].Added == nil || *p.Files[0].Added != 1 || *p.Files[0].Deleted != 1 {
		t.Fatalf("source +/- miscounted %#v %v", p, err)
	}
}

func TestResourceBudgetRejectsNewEvidenceWithoutReplacingTrustedBytes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		used  int64
		other bool
	}{{"conversation", 64 << 20, false}, {"profile", 1 << 30, true}} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openTestStore(t)
			createConversation(t, s, "a")
			createConversation(t, s, "b")
			ctx := context.Background()
			w := s.NewWriter(WriterOptions{})
			defer w.Close()
			owner := "a"
			if tc.other {
				owner = "b"
			}
			_, err := w.Submit(ctx, Batch{ConversationID: owner, FileObservations: []filechanges.Observation{{OperationID: "seed", Cwd: "/repo", Path: "trusted", Before: snap("old", true), After: snap("new", true)}}})
			if err != nil {
				t.Fatal(err)
			}
			// Account for an already occupied budget without allocating a GiB in the test.
			if _, err = s.write.ExecContext(ctx, "UPDATE conversation_file_change SET bytes = ? WHERE conversation_id = ?", tc.used, owner); err != nil {
				t.Fatal(err)
			}
			if _, err = w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: "denied", Cwd: "/repo", Path: "new", Before: snap("", false), After: snap("new content", true)}}}); err != nil {
				t.Fatal(err)
			}
			p, err := s.ResourcePage(ctx, "a", "")
			if err != nil {
				t.Fatal(err)
			}
			var rejected *FileResource
			for i := range p.Files {
				if p.Files[i].Path == "new" {
					rejected = &p.Files[i]
				}
			}
			if rejected == nil || rejected.Reason != "storage_limit" || rejected.Added != nil || rejected.Deleted != nil {
				t.Fatalf("quota %#v", p)
			}
			detail, err := s.ChangeDetail(ctx, "a", rejected.ID, p.Revision)
			if err != nil || detail.Before != "" || detail.After != "" || detail.Patch != "" {
				t.Fatalf("quota exposed evidence %#v %v", detail, err)
			}
			prior, err := s.ResourcePage(ctx, owner, "")
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range prior.Files {
				if f.Path == "trusted" {
					d, err := s.ChangeDetail(ctx, owner, f.ID, prior.Revision)
					if err != nil || d.Before != "old" || d.After != "new" {
						t.Fatalf("quota replaced trusted bytes %#v %v", d, err)
					}
				}
			}
		})
	}
}

func TestSamePathInDifferentWorkingDirectoriesHasIndependentBaselines(t *testing.T) {
	s, _ := openTestStore(t)
	createConversation(t, s, "a")
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	ctx := context.Background()
	for i, cwd := range []string{"/first", "/second"} {
		_, err := w.Submit(ctx, Batch{ConversationID: "a", FileObservations: []filechanges.Observation{{OperationID: fmt.Sprint(i), Cwd: cwd, Path: "same.ts", Before: snap(cwd+" before", true), After: snap(cwd+" after", true)}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.ResourcePage(ctx, "a", "")
	if err != nil || len(p.Files) != 2 {
		t.Fatalf("cwd merged %#v %v", p, err)
	}
	for _, f := range p.Files {
		d, err := s.ChangeDetail(ctx, "a", f.ID, p.Revision)
		if err != nil || d.Before != f.Cwd+" before" || d.After != f.Cwd+" after" {
			t.Fatalf("cross-cwd detail %#v %v", d, err)
		}
	}
}
