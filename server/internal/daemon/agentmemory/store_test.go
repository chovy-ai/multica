package agentmemory

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAgent = "11111111-1111-4111-8111-111111111111"

func input(path string) WriteInput {
	return WriteInput{Path: path, Title: "迁移先出方案", Description: "Plan before migration", Body: "**Why:** preference\n**How to apply:** migrations running carefully", Mode: "create", Source: "CHOV-117"}
}
func TestPathsAndLinks(t *testing.T) {
	for _, path := range []string{"feedback/test", "reference/test.md", "project/general/test", "project/multica-3f9a1c2b7d0e/test.md"} {
		if _, err := NormalizePath(path); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
	for _, path := range []string{"../feedback/a", "/feedback/a", "feedback/../a", "feedback\\a", "feedback/.a", "feedback//a", "user/a", "feedback/UPPER", "project/a/x", "project/general/a/extra", "feedback/" + strings.Repeat("a", 65)} {
		if _, err := NormalizePath(path); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("accepted %s", path)
		}
	}
	m := NewManager(t.TempDir())
	root, _ := m.Root(testAgent)
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "feedback")); err != nil {
		t.Skip(err)
	}
	if _, _, err := m.Write(testAgent, input("feedback/link")); !errors.Is(err, ErrInvalidPath) {
		t.Fatal(err)
	}
	if _, err := m.Root("../evil"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal(err)
	}
}
func TestEntryRoundTripAndVersions(t *testing.T) {
	m := NewManager(t.TempDir())
	in := input("feedback/test")
	e, _, err := m.Write(testAgent, in)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.Write(testAgent, in); !errors.Is(err, ErrAlreadyExists) {
		t.Fatal(err)
	}
	root, _ := m.Root(testAgent)
	path := filepath.Join(root, e.Path)
	data, _ := os.ReadFile(path)
	data = bytes.Replace(data, []byte("source: CHOV-117\n"), []byte("source: CHOV-117\ncustom: retained\n"), 1)
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	in.Mode = "update"
	in.ExpectedUpdatedAt = &e.UpdatedAt
	in.Source = "overwrite"
	in.Title = "new"
	changed, _, err := m.Write(testAgent, in)
	if err != nil {
		t.Fatal(err)
	}
	if !changed.CreatedAt.Equal(e.CreatedAt) || !changed.UpdatedAt.After(e.UpdatedAt) || changed.Source != e.Source {
		t.Fatalf("bad update: %+v", changed)
	}
	data, _ = os.ReadFile(path)
	if !bytes.Contains(data, []byte("custom: retained")) {
		t.Fatal("lost unknown frontmatter")
	}
	if _, _, err = m.Write(testAgent, in); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}
	in.ExpectedUpdatedAt = nil
	in.Body = strings.Repeat("a", 2049)
	if _, warnings, err := m.Write(testAgent, in); err != nil || len(warnings) != 1 {
		t.Fatalf("soft limit: %v %v", warnings, err)
	}
	in.Body = strings.Repeat("a", 8193)
	if _, _, err = m.Write(testAgent, in); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
	in.Body = "ok"
	in.Description = "line\nbreak"
	if _, _, err = m.Write(testAgent, in); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	in.Description = "ok"
	in.Title = strings.Repeat("中", 101)
	if _, _, err = m.Write(testAgent, in); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
}
func TestProjectsAndConcurrentWrites(t *testing.T) {
	m := NewManager(t.TempDir())
	p := ProjectRef{"22222222-2222-4222-8222-3f9a1c2b7d0e", "Multica 桌面端"}
	dir, err := m.ResolveProjectDir(testAgent, p)
	if err != nil || dir != "multica-3f9a1c2b7d0e" {
		t.Fatalf("%s %v", dir, err)
	}
	in := input("project/" + dir + "/test")
	in.Project = p
	if _, _, err = m.Write(testAgent, in); err != nil {
		t.Fatal(err)
	}
	p.Title = "Renamed"
	if got, err := m.ResolveProjectDir(testAgent, p); err != nil || got != dir {
		t.Fatalf("rename %s %v", got, err)
	}
	in.Mode = "update"
	in.Project = p
	if _, _, err = m.Write(testAgent, in); err != nil {
		t.Fatal(err)
	}
	index, err := m.Index(testAgent)
	if err != nil || !strings.Contains(index, "### Renamed") {
		t.Fatalf("%s %v", index, err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, _, err := m.Write(testAgent, input("feedback/"+string(rune('a'+i)))); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	entries, err := m.List(testAgent)
	if err != nil || len(entries) != 21 {
		t.Fatalf("%d %v", len(entries), err)
	}
	first, err := m.Index(testAgent)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := m.Index(testAgent)
	if first != second {
		t.Fatal("unstable index")
	}
	for _, e := range entries {
		if !strings.Contains(first, e.Path) {
			t.Fatal(e.Path)
		}
	}
}
func TestSearchRecoveryAndEscaping(t *testing.T) {
	m := NewManager(t.TempDir())
	if _, _, err := m.Write(testAgent, input("feedback/test")); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"running", "迁移"} {
		hits, err := m.Search(testAgent, q, 10)
		if err != nil || len(hits) != 1 {
			t.Fatalf("%q: %+v %v", q, hits, err)
		}
	}
	for _, q := range []string{"%", "_"} {
		hits, err := m.Search(testAgent, q, 10)
		if err != nil || len(hits) != 0 {
			t.Fatalf("escaped %q: %+v %v", q, hits, err)
		}
	}
	if _, err := m.Search(testAgent, " ", 10); !errors.Is(err, ErrInvalidInput) {
		t.Fatal(err)
	}
	path, _ := m.ftsPath(testAgent)
	if err := os.WriteFile(path, []byte("garbage"), 0600); err != nil {
		t.Fatal(err)
	}
	if hits, err := m.Search(testAgent, "迁移", 100); err != nil || len(hits) != 1 {
		t.Fatalf("corrupt recovery: %+v %v", hits, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if hits, err := m.Search(testAgent, "迁移", 10); err != nil || len(hits) != 1 {
		t.Fatalf("missing recovery: %+v %v", hits, err)
	}
}
func TestTrashRestoreClearAndPrune(t *testing.T) {
	profile := t.TempDir()
	m := NewManager(profile)
	e, _, err := m.Write(testAgent, input("feedback/test"))
	if err != nil {
		t.Fatal(err)
	}
	rel, err := m.Delete(testAgent, e.Path)
	if err != nil {
		t.Fatal(err)
	}
	items, err := m.Trash(testAgent)
	if err != nil || len(items) != 1 {
		t.Fatalf("%+v %v", items, err)
	}
	restored, err := m.Restore(testAgent, rel)
	if err != nil || !restored.UpdatedAt.Equal(e.UpdatedAt) {
		t.Fatalf("restore: %+v %v", restored, err)
	}
	rel, err = m.Delete(testAgent, e.Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.Write(testAgent, input(e.Path)); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Restore(testAgent, rel); !errors.Is(err, ErrRestoreTargetExists) {
		t.Fatal(err)
	}
	if err = m.Clear(testAgent); err != nil {
		t.Fatal(err)
	}
	entries, err := m.List(testAgent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("%v %v", entries, err)
	}
	items, err = m.Trash(testAgent)
	if err != nil || len(items) != 2 {
		t.Fatalf("%v %v", items, err)
	}
	if n, err := PruneTrash(profile, 30*24*time.Hour, time.Now()); err != nil || n != 0 {
		t.Fatalf("prune %d %v", n, err)
	}
	if n, err := PruneTrash(profile, 30*24*time.Hour, time.Now().Add(31*24*time.Hour)); err != nil || n < 1 {
		t.Fatalf("prune %d %v", n, err)
	}
}
func TestSnapshotAndReceipts(t *testing.T) {
	m := NewManager(t.TempDir())
	for _, path := range []string{"feedback/test", "project/general/test", "project/other-111111111111/test"} {
		if _, _, err := m.Write(testAgent, input(path)); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := m.Snapshot(testAgent, "")
	if err != nil || len(snap.State) != 2 || !strings.Contains(snap.Text, "1 more entries") {
		t.Fatalf("%+v %v", snap, err)
	}
	prev := map[string]SnapshotLine{"feedback/test.md": {Path: "feedback/test.md", Title: "old"}, "reference/deleted.md": {Path: "reference/deleted.md"}}
	a, c, r := snap.Diff(prev)
	if len(a) != 1 || len(c) != 1 || len(r) != 1 {
		t.Fatalf("%v %v %v", a, c, r)
	}
	for i := 0; i < 30; i++ {
		in := input("reference/" + string(rune('a'+i/26)) + string(rune('a'+i%26)))
		in.Description = strings.Repeat("中", 200)
		if _, _, err = m.Write(testAgent, in); err != nil {
			t.Fatal(err)
		}
	}
	snap, err = m.Snapshot(testAgent, "")
	if err != nil || len(snap.Text) > 8192 || !strings.Contains(snap.Text, "older entries omitted") {
		t.Fatalf("size %d %v", len(snap.Text), err)
	}
	for path := range snap.State {
		if !strings.Contains(snap.Text, path) {
			t.Fatal("state contains omitted entry")
		}
	}
	root := t.TempDir()
	if err := RecordReceipt(root, "a", "A"); err != nil {
		t.Fatal(err)
	}
	if err := RecordReceipt(root, "a", "B"); err != nil {
		t.Fatal(err)
	}
	titles, err := ClaimReceipts(root)
	if err != nil || strings.Join(titles, ",") != "B" {
		t.Fatalf("%v %v", titles, err)
	}
	titles, err = ClaimReceipts(root)
	if err != nil || len(titles) != 0 {
		t.Fatalf("%v %v", titles, err)
	}
}
