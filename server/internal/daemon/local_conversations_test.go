package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestProviderConfigFiles(t *testing.T) {
	t.Parallel()

	env := func(values map[string]string) func(string) string {
		return func(k string) string { return values[k] }
	}
	home := func() (string, error) { return "/home/me", nil }
	cases := []struct {
		provider string
		values   map[string]string
		want     string
	}{
		{"codex", nil, "[/home/me/.codex/config.toml /home/me/.codex/auth.json]"},
		{"codex", map[string]string{"CODEX_HOME": "/c"}, "[/c/config.toml /c/auth.json]"},
		{"claude", nil, "[/home/me/.claude.json /home/me/.claude/settings.json /home/me/.claude/.credentials.json]"},
		{"claude", map[string]string{"CLAUDE_CONFIG_DIR": "/d"}, "[/d/.claude.json /d/settings.json /d/.credentials.json]"},
		{"other", nil, "[]"},
	}
	for _, c := range cases {
		if got := fmt.Sprint(providerConfigFiles(c.provider, env(c.values), home)); got != c.want {
			t.Errorf("%s %v = %s, want %s", c.provider, c.values, got, c.want)
		}
	}
	if got := providerConfigFiles("codex", env(nil), func() (string, error) { return "", errors.New("no home") }); len(got) != 2 {
		t.Errorf("without a home = %v", got)
	}
}

func TestSpareConditionsRequireAnInstalledCLIAndASignedInUser(t *testing.T) {
	t.Parallel()

	profile := t.TempDir()
	d := &Daemon{cfg: Config{ProfileDir: profile, Agents: map[string]AgentEntry{}}}
	if got := d.spareConditions(context.Background(), "codex"); got.Ready {
		t.Fatalf("ready with no CLI: %+v", got)
	}
	d.cfg.Agents["codex"] = AgentEntry{Path: filepath.Join(profile, "missing-codex")}
	if got := d.spareConditions(context.Background(), "codex"); got.Ready {
		t.Fatalf("ready with nobody signed in: %+v", got)
	}
	if err := os.WriteFile(filepath.Join(profile, ".desktop-user-id"), []byte("user-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := d.spareConditions(context.Background(), "codex"); got.Ready {
		t.Fatalf("ready with no credentials: %+v", got)
	}
}
