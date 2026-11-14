package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/runtimeinstance"
	"github.com/spf13/cobra"
)

func runtimeStoreFixture(t *testing.T) (runtimeinstance.Store, runtimeinstance.Launch) {
	t.Helper()
	t.Chdir(t.TempDir())
	for _, key := range []string{"MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_DAEMON_PORT", runtimeinstance.OwnerEnv} {
		t.Setenv(key, "")
	}
	store := runtimeinstance.New(t.TempDir())
	before := openInstanceStore
	openInstanceStore = func() (runtimeinstance.Store, error) { return store, nil }
	t.Cleanup(func() { openInstanceStore = before })
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(t.TempDir(), "host.js")
	if err := os.WriteFile(entry, []byte("test-owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	l := runtimeinstance.Launch{SchemaVersion: 1, InstanceID: "desktop", OwnerID: strings.Repeat("1", 32), Kind: "development", AppPath: filepath.Dir(entry), CLIPath: exe, ElectronPath: exe, ClaudeEntryPath: entry, CLIVersion: "0.7.0", CLICommit: "bcdfa010e", Profile: "desktop-runtime", APIURL: "https://api.example.test", ProtocolVersion: 2}
	if err := store.PublishLaunch(l); err != nil {
		t.Fatal(err)
	}
	return store, l
}

func instanceTestCommand(profile string) *cobra.Command {
	c := &cobra.Command{Use: "status"}
	c.SetContext(context.Background())
	c.Flags().String("profile", profile, "")
	return c
}

func TestRuntimeInstanceSelectionHonorsSingleDesktopAndTaskBoundary(t *testing.T) {
	store, launch := runtimeStoreFixture(t)
	cmd := instanceTestCommand("")
	if err := selectRuntimeInstance(cmd, nil); err != nil {
		t.Fatal(err)
	}
	if resolveProfile(cmd) != runtimeinstance.ProfileName || selectedInstance(cmd) == nil {
		t.Fatal("registered CLI did not adopt Desktop profile")
	}
	ordinary := instanceTestCommand("my-server")
	if err := selectRuntimeInstance(ordinary, nil); err != nil || selectedInstance(ordinary) != nil {
		t.Fatal("changed explicit standalone profile", err)
	}
	t.Setenv(runtimeinstance.OwnerEnv, strings.Repeat("2", 32))
	if err := selectRuntimeInstance(instanceTestCommand("desktop-runtime"), nil); err == nil {
		t.Fatal("accepted superseded Desktop")
	}
	t.Setenv(runtimeinstance.OwnerEnv, "")
	launch.CLIPath = launch.ClaudeEntryPath
	if err := store.PublishLaunch(launch); err != nil {
		t.Fatal(err)
	}
	if err := selectRuntimeInstance(instanceTestCommand("desktop-runtime"), nil); err == nil {
		t.Fatal("accepted old worktree CLI")
	}
	t.Setenv("MULTICA_TASK_ID", "test-task")
	task := instanceTestCommand("")
	if err := selectRuntimeInstance(task, nil); err != nil || selectedInstance(task) != nil || resolveProfile(task) != "" {
		t.Fatal("task adopted owner's Desktop credentials", err)
	}
}

func TestRuntimeInstanceSelectionPreservesPrivateContextConfig(t *testing.T) {
	_, launch := runtimeStoreFixture(t)
	root := t.TempDir()
	t.Setenv(cli.TaskConfigRootEnv, root)
	t.Setenv("MULTICA_TOKEN", "")
	const workspace = "context-workspace"
	const token = "private-desktop-credential"
	requests := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("X-Workspace-ID") != workspace {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/comments") {
			fmt.Fprint(w, `[{"id":"comment","content":"complete discussion"}]`)
			return
		}
		fmt.Fprintf(w, `{"id":%q,"workspace_id":%q,"description":"complete task body"}`, contextIssueID, workspace)
	}))
	t.Cleanup(api.Close)
	if err := cli.SaveCLIConfig(cli.CLIConfig{ServerURL: api.URL, WorkspaceID: workspace, Token: token}); err != nil {
		t.Fatal(err)
	}
	cmd, out := contextTestCommand()
	cmd.Flags().String("profile", "", "")
	cmd.Flags().String("server-url", "", "")
	cmd.Flags().String("workspace-id", "", "")
	_ = cmd.Flags().Set("server-url", api.URL)
	_ = cmd.Flags().Set("workspace-id", workspace)
	cmd.SetContext(context.Background())
	if err := selectRuntimeInstance(cmd, nil); err != nil {
		t.Fatal(err)
	}
	if err := runIssueContext(cmd, []string{contextIssueID}); err != nil {
		t.Fatalf("context CLI lost its private config after runtime selection: %v (selected profile %q, desktop profile %q)", err, resolveProfile(cmd), launch.Profile)
	}
	if resolveProfile(cmd) != "" || selectedInstance(cmd) != nil {
		t.Fatal("private context CLI adopted the registered Desktop profile")
	}
	if requests != 2 || !strings.Contains(out.String(), "complete task body") || !strings.Contains(out.String(), "complete discussion") {
		t.Fatalf("incomplete context: requests=%d output=%s", requests, out.String())
	}
}

func TestRuntimeInstanceHealthRejectsStaleRunsAndPortReuse(t *testing.T) {
	store, l := runtimeStoreFixture(t)
	r := runtimeinstance.Runtime{SchemaVersion: 1, InstanceID: "desktop", OwnerID: l.OwnerID, RunID: strings.Repeat("2", 32), PID: 1234, Profile: l.Profile, APIURL: l.APIURL, CLIVersion: l.CLIVersion, CLICommit: l.CLICommit, APIVersion: 2, SidecarProtocolVersion: 2, LocalConversations: true, StartedAt: "2026-10-28T10:00:00Z"}
	response := map[string]any{"instance_id": r.InstanceID, "instance_owner_id": r.OwnerID, "instance_run_id": r.RunID, "pid": r.PID, "profile": r.Profile, "cli_version": r.CLIVersion, "cli_commit": r.CLICommit, "server_url": r.APIURL, "status": "running"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/health" {
			t.Error(req.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	r.Port, _ = strconv.Atoi(port)
	if err := store.PublishRuntime(r); err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifiedRuntimeHealth(context.Background(), store, "desktop"); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"instance_run_id", "instance_owner_id", "pid", "profile", "cli_commit", "server_url"} {
		original := response[field]
		response[field] = "wrong"
		if _, _, err := verifiedRuntimeHealth(context.Background(), store, "desktop"); err == nil {
			t.Fatal("accepted stale health", field)
		}
		response[field] = original
	}
	if dir := daemonDirForProfile("desktop-runtime"); dir == "" || !filepath.IsAbs(dir) || !strings.HasSuffix(dir, ".multica"+string(filepath.Separator)+"desktop-runtime") {
		t.Fatal("wrong shared state directory", dir)
	}
}
