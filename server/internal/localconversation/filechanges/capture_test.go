package filechanges

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func put(t *testing.T, root, path, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestNativePatchEvidenceAndExternalWrites(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a.ts", "user change\nA\n")
	c := Scan(root)
	put(t, root, "a.ts", "user change\nB\n")
	o := c.Codex("one", "turn", "a.ts", "", "update", "@@ -1,2 +1,2 @@\n user change\n-A\n+B\n", true)
	if o.Reason != "" || o.Before.Content != "user change\nA\n" {
		t.Fatalf("evidence %#v", o)
	}
	put(t, root, "a.ts", "user change\nC\n")
	next := c.Codex("two", "turn", "a.ts", "", "update", "@@ -2 +2 @@\n-B\n+C\n", true)
	if next.Reason != "" || next.Before.Content != o.After.Content {
		t.Fatalf("next %#v", next)
	}
	put(t, root, "a.ts", "external\nC\n")
	unknown := c.Unknown("turn")
	if len(unknown) != 1 || unknown[0].Reason != "uncertain" {
		t.Fatalf("external update was trusted: %#v", unknown)
	}
}

func TestCaptureLimitsExclusionsAndSymlinks(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a", "A")
	put(t, root, ".env", "secret")
	put(t, root, "large", strings.Repeat("x", MaxFileBytes+1))
	put(t, root, "binary", "a\x00b")
	outside := t.TempDir()
	put(t, outside, "private", "secret")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{".env": "excluded", "large": "large_file", "binary": "binary", "escape/private": "outside_scope", "../private": "outside_scope"} {
		if got := Read(root, path); got.Reason != want || got.Content != "" {
			t.Fatalf("%s: %#v", path, got)
		}
	}
	c := Scan(root)
	if _, ok := c.Files[".env"]; ok {
		t.Fatal("captured credentials")
	}
	if len(Scan("").Files) != 0 {
		t.Fatal("empty cwd scanned the process directory")
	}
}

func TestNoWriteFailedAndUnverifiedPatch(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a", "A\n")
	c := Scan(root)
	put(t, root, "a", "B\n")
	for _, tc := range []struct {
		patch   string
		success bool
	}{{"@@ -1 +1 @@\n-X\n+B\n", true}, {"@@ -1 +1 @@\n-A\n+B\n", false}, {"", true}} {
		if o := c.Codex("op", "turn", "a", "", "update", tc.patch, tc.success); o.Reason != "uncertain" {
			t.Fatalf("unverified edit was trusted: %#v", o)
		}
	}
	put(t, root, "a", "A\n")
	put(t, root, "shell", "new")
	u := c.Unknown("turn")
	if len(u) != 1 || u[0].Path != "shell" {
		t.Fatalf("shell discovery %#v", u)
	}
}

func TestExactPatchMatrix(t *testing.T) {
	for _, tc := range []struct {
		old, patch, kind, want string
		valid                  bool
	}{
		{"a\r\n", "@@ -1 +1 @@\n-a\r\n+b\r\n", "update", "b\r\n", true},
		{"a", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n", "update", "b", true},
		{"", "new\n", "add", "new\n", true},
		{"a\n", "@@ -1 +0,0 @@\n-a\n", "delete", "", true},
		{"a\n", "@@ -1,2 +1 @@\n-a\n+b\n", "update", "", false},
		{"a\n", "@@ -1 +1 @@\n-x\n+b\n", "update", "", false},
		{"a\n", "", "move", "a\n", true},
	} {
		got, ok := Apply(tc.old, tc.patch, tc.kind)
		if ok != tc.valid || ok && got != tc.want {
			t.Fatalf("%#v: %q %v", tc, got, ok)
		}
	}
}
