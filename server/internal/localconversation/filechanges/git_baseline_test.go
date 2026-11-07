package filechanges

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCaptureKeepsExistingUserContentAndGitIndex(t *testing.T) {
	root := t.TempDir()
	git := func(args ...string) []byte {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return out
	}
	git("init", "--quiet")
	put(t, root, "a.ts", "A\n")
	git("add", "a.ts")
	put(t, root, "a.ts", "user\nA\n")
	status := git("status", "--porcelain=v1", "-z")
	cached := git("diff", "--cached", "--binary")
	index, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil {
		t.Fatal(err)
	}
	c := Scan(root)
	put(t, root, "a.ts", "user\nB\n")
	out := c.NativeBatch("turn", []NativeChange{{OperationID: "edit", Path: "a.ts", Kind: "update", Patch: "@@ -1,2 +1,2 @@\n user\n-A\n+B\n", Success: true}})
	if len(out) != 1 || out[0].Reason != "" || out[0].Before.Content != "user\nA\n" || out[0].After.Content != "user\nB\n" {
		t.Fatal(out)
	}
	after, err := os.ReadFile(filepath.Join(root, ".git/index"))
	if err != nil || !bytes.Equal(index, after) {
		t.Fatal("capture changed the index", err)
	}
	if !bytes.Equal(cached, git("diff", "--cached", "--binary")) || !bytes.Equal(status, git("status", "--porcelain=v1", "-z")) {
		t.Fatal("capture changed staged contents or status classification")
	}
}
