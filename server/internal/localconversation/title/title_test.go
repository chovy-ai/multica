package title

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSummarize(t *testing.T) {
	t.Parallel()

	for _, c := range []struct{ in, want string }{
		{"请帮我修复登录页的崩溃。然后再看看别的", "修复登录页的崩溃。"},
		{"Please add **dark mode** to the [settings](https://x.y) page", "add dark mode to the settings page"},
		{"看一下 [@MUL-12 登录问题](mention://issue/abc) 的进度", "看一下 的进度 · MUL-12 登录问题"},
		{"", "新会话"},
		{"hi" + contextStart + "secret context" + contextEnd, "hi"},
		{strings.Repeat("长", 60), strings.Repeat("长", 47) + "…"},
	} {
		if got := Summarize(c.in); got != c.want {
			t.Errorf("Summarize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalize(t *testing.T) {
	t.Parallel()

	if got, ok := Normalize("  # “登录崩溃排查”  "); !ok || got != "登录崩溃排查" {
		t.Fatalf("Normalize = %q %v", got, ok)
	}
	for _, bad := range []string{"", "two\nlines", "see https://x", "新会话", strings.Repeat("x", 161)} {
		if _, ok := Normalize(bad); ok {
			t.Errorf("accepted %q", bad)
		}
	}
}

func fakeCLI(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cli")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGenerate(t *testing.T) {
	t.Parallel()

	claude := fakeCLI(t, `cat > /dev/null; echo '"修复登录崩溃"'`)
	if got, err := Generate(context.Background(), Request{Provider: "claude", Executable: claude, Content: "帮我修复登录崩溃"}); err != nil || got != "修复登录崩溃" {
		t.Fatalf("claude = %q, %v", got, err)
	}
	// Codex writes its last message to the --output-last-message file.
	codex := fakeCLI(t, `while [ $# -gt 0 ]; do if [ "$1" = "--output-last-message" ]; then out=$2; fi; shift; done; cat > /dev/null; echo "Fix login crash" > "$out"`)
	if got, err := Generate(context.Background(), Request{Provider: "codex", Executable: codex, Content: "fix the login crash"}); err != nil || got != "Fix login crash" {
		t.Fatalf("codex = %q, %v", got, err)
	}
	empty := fakeCLI(t, `cat > /dev/null; echo ""`)
	if _, err := Generate(context.Background(), Request{Provider: "claude", Executable: empty, Content: "x"}); err != ErrNoTitle {
		t.Fatalf("empty output = %v", err)
	}
}
