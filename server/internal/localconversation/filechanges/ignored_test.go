package filechanges

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func ignoredFixture(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	if out, err := exec.Command("git", "-C", root, "init", "--quiet").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	put(t, root, ".gitignore", "ignored.txt\ncache/\n*.out\n")
	return root
}

func TestIgnoredExistingPathsDoNotProveAnEmptyBaseline(t *testing.T) {
	for _, path := range []string{"ignored.txt", "cache/existing.txt"} {
		t.Run(path, func(t *testing.T) {
			root := ignoredFixture(t)
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0700); err != nil {
				t.Fatal(err)
			}
			put(t, root, path, "pre-existing user bytes\n")
			c := Scan(root)
			if !c.Complete {
				t.Fatal("small scan did not complete")
			}
			if before := c.Before(path); before.Reason == "" || before.Content != "" {
				t.Fatalf("ignored baseline: %+v", before)
			}
			put(t, root, path, "replacement\n")
			out := c.NativeBatch("turn", []NativeChange{{OperationID: "overwrite", Path: path, Kind: "add", Patch: "replacement\n", Success: true}})
			if len(out) != 1 || out[0].Reason != "excluded" || out[0].Before.Reason != "excluded" || out[0].Before.Hash != "" || !out[0].After.Exists {
				t.Fatalf("unsampled file must not acquire a verified baseline: %+v", out)
			}
		})
	}
}

func TestNewIgnoredFileKeepsItsVerifiedAdditionAfterTheTurn(t *testing.T) {
	root := ignoredFixture(t)
	c := Scan(root)
	put(t, root, "ignored.txt", "new\n")
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "create", Path: "ignored.txt", Kind: "add", Patch: "new\n", Success: true}})
	if len(out) != 1 || out[0].Reason != "" || out[0].Before.Exists || !out[0].After.Exists {
		t.Fatalf("new file: %+v", out)
	}
	if unknown := c.Unknown("turn"); len(unknown) != 0 {
		t.Fatalf("ignore listing invented a deletion: %+v", unknown)
	}
}

func TestIgnoredRecordedFileIsCheckedAtItsActualPath(t *testing.T) {
	root := ignoredFixture(t)
	put(t, root, "ignored.txt", "before\n")
	c := Scan(root)
	put(t, root, "ignored.txt", "after\n")
	c.Recorded(Observation{Path: "ignored.txt", After: Read(root, "ignored.txt")})
	if unknown := c.Unknown("turn"); len(unknown) != 0 {
		t.Fatalf("recorded hook evidence became a deletion: %+v", unknown)
	}
	if err := os.Remove(filepath.Join(root, "ignored.txt")); err != nil {
		t.Fatal(err)
	}
	unknown := c.Unknown("turn")
	if len(unknown) != 1 || unknown[0].Path != "ignored.txt" || unknown[0].After.Exists || unknown[0].Reason != "uncertain" {
		t.Fatalf("actual external deletion not detected: %+v", unknown)
	}
}

func TestTrackedFileMatchingAnIgnorePatternKeepsItsBaseline(t *testing.T) {
	root := ignoredFixture(t)
	put(t, root, "tracked.out", "before\n")
	if out, err := exec.Command("git", "-C", root, "add", "-f", "tracked.out").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v %s", err, out)
	}
	c := Scan(root)
	put(t, root, "tracked.out", "after\n")
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "update", Path: "tracked.out", Kind: "update", Patch: "@@ -1 +1 @@\n-before\n+after\n", Success: true}})
	if len(out) != 1 || out[0].Reason != "" || out[0].Before.Content != "before\n" {
		t.Fatalf("tracked evidence: %+v", out)
	}
}

func TestIgnoreRuleChangesDoNotInventAnEarlierAbsence(t *testing.T) {
	root := ignoredFixture(t)
	put(t, root, "ignored.txt", "user bytes\n")
	c := Scan(root)
	put(t, root, ".gitignore", "")
	put(t, root, "ignored.txt", "replacement\n")
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "overwrite", Path: "ignored.txt", Kind: "add", Patch: "replacement\n", Success: true}})
	if len(out) != 1 || out[0].Reason != "excluded" || out[0].Before.Hash != "" {
		t.Fatalf("initial ignore boundary was lost: %+v", out)
	}
}

func TestNativeRenameDoesNotInferAnUnsampledDestination(t *testing.T) {
	root := ignoredFixture(t)
	put(t, root, "source.txt", "source\n")
	put(t, root, "ignored.txt", "user destination\n")
	c := Scan(root)
	put(t, root, "ignored.txt", "source\n")
	if err := os.Remove(filepath.Join(root, "source.txt")); err != nil {
		t.Fatal(err)
	}
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "move", Path: "source.txt", MovePath: "ignored.txt", Kind: "move", Success: true}})
	if len(out) != 2 || out[0].Reason != "excluded" || out[0].MovePath != "" || out[0].After.Exists || out[1].Path != "ignored.txt" || out[1].Reason != "excluded" || !out[1].After.Exists {
		t.Fatalf("unsampled rename target: %+v", out)
	}
}

func TestIncompleteBaselineDoesNotInventCurrentDeletion(t *testing.T) {
	root := ignoredFixture(t)
	put(t, root, "existing.txt", "current\n")
	c := &Capture{Root: root, Files: map[string]Snapshot{}}
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "add", Path: "existing.txt", Kind: "add", Patch: "current\n", Success: true}})
	if len(out) != 1 || out[0].Reason != "missing_baseline" || !out[0].After.Exists || out[0].After.Content != "current\n" {
		t.Fatalf("missing baseline invented a current deletion: %+v", out)
	}
}
