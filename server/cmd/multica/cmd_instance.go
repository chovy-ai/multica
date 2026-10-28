package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/multica-ai/multica/server/internal/runtimeinstance"
	"github.com/spf13/cobra"
)

var openInstanceStore = runtimeinstance.Default

type instanceContextKey struct{}
type selectedRuntimeInstance struct {
	store  runtimeinstance.Store
	launch runtimeinstance.Launch
}

func selectedInstance(cmd *cobra.Command) *selectedRuntimeInstance {
	value, _ := cmd.Context().Value(instanceContextKey{}).(*selectedRuntimeInstance)
	return value
}

// The shared launcher points to the last Desktop's CLI. Explicit standalone
// profiles and daemon task credentials retain their existing semantics.
func selectRuntimeInstance(cmd *cobra.Command, _ []string) error {
	if cmd.Name() == "version" {
		return nil
	}
	if inDaemonManagedExecutionContext() {
		return nil
	}
	profile, _ := cmd.Flags().GetString("profile")
	discovery := cmd.Parent() != nil && cmd.Parent().Name() == "instance"
	if profile != "" && profile != runtimeinstance.ProfileName {
		return nil
	}
	store, err := openInstanceStore()
	if err != nil {
		return err
	}
	launch, err := store.ReadLaunch(runtimeinstance.InstanceID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && profile == "" && (!discovery || cmd.Name() == "list") {
			return nil
		}
		return fmt.Errorf("read Desktop runtime registration: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if profile == "" && !discovery && !runtimeinstance.SameFile(exe, launch.CLIPath) {
		return nil
	}
	if owner := os.Getenv(runtimeinstance.OwnerEnv); owner != "" && owner != launch.OwnerID {
		return fmt.Errorf("another Desktop has taken over this runtime; use the most recently started Desktop")
	}
	if !discovery && !runtimeinstance.SameFile(exe, launch.CLIPath) {
		return fmt.Errorf("this CLI belongs to a previous Desktop; use the registered terminal command")
	}
	if err := cmd.Flags().Set("profile", launch.Profile); err != nil {
		return err
	}
	cmd.SetContext(context.WithValue(cmd.Context(), instanceContextKey{}, &selectedRuntimeInstance{store, launch}))
	return nil
}

func registeredInstance(profile string) (*selectedRuntimeInstance, error) {
	id := runtimeinstance.IDFromProfile(profile)
	if id == "" {
		return nil, nil
	}
	store, err := openInstanceStore()
	if err != nil {
		return nil, err
	}
	launch, err := store.ReadLaunch(id)
	if err != nil {
		return nil, err
	}
	return &selectedRuntimeInstance{store, launch}, nil
}

func verifiedRuntimeHealth(ctx context.Context, store runtimeinstance.Store, id string) (runtimeinstance.Runtime, map[string]any, error) {
	r, err := store.ReadRuntime(id)
	if err != nil {
		return r, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", r.Port), nil)
	if err != nil {
		return r, nil, err
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return r, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return r, nil, fmt.Errorf("runtime health returned HTTP %d", resp.StatusCode)
	}
	var health map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&health); err != nil {
		return r, nil, err
	}
	if health["instance_id"] != r.InstanceID || health["instance_owner_id"] != r.OwnerID || health["instance_run_id"] != r.RunID || health["profile"] != r.Profile || health["pid"] != float64(r.PID) || health["cli_version"] != r.CLIVersion || health["cli_commit"] != r.CLICommit || health["server_url"] != r.APIURL {
		return r, nil, fmt.Errorf("registered runtime identity mismatch")
	}
	return r, health, nil
}

var instanceCmd = &cobra.Command{Use: "instance", Short: "Discover Desktop runtime instances"}
var instanceListCmd = &cobra.Command{Use: "list", Short: "List registered Desktop runtimes", RunE: func(cmd *cobra.Command, _ []string) error {
	if err := requireHumanLocalCommand("instance list"); err != nil {
		return err
	}
	store, err := openInstanceStore()
	if err != nil {
		return err
	}
	ids, err := store.IDs()
	if err != nil {
		return err
	}
	rows := []map[string]any{}
	for _, id := range ids {
		launch, err := store.ReadLaunch(id)
		if err != nil {
			rows = append(rows, map[string]any{"instanceId": id, "state": "invalid"})
			continue
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Second)
		r, health, err := verifiedRuntimeHealth(ctx, store, id)
		cancel()
		state := "offline"
		if err == nil && health["status"] == "running" {
			state = "running"
			if r.OwnerID != launch.OwnerID || !launch.MatchesVersion(r.CLIVersion, r.CLICommit) {
				state = "replacing"
			}
		}
		rows = append(rows, map[string]any{"instanceId": id, "kind": launch.Kind, "apiUrl": launch.APIURL, "cliPath": launch.CLIPath, "profile": launch.Profile, "state": state, "localConversations": err == nil && r.LocalConversations})
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(rows)
}}
var instanceStatusCmd = &cobra.Command{Use: "status", Short: "Verify the selected runtime's identity and capabilities", RunE: func(cmd *cobra.Command, _ []string) error {
	if err := requireHumanLocalCommand("instance status"); err != nil {
		return err
	}
	selected := selectedInstance(cmd)
	if selected == nil {
		return fmt.Errorf("start Multica Desktop to register its runtime")
	}
	r, _, err := verifiedRuntimeHealth(cmd.Context(), selected.store, selected.launch.InstanceID)
	if err != nil {
		return err
	}
	if r.OwnerID != selected.launch.OwnerID || r.APIURL != selected.launch.APIURL || !selected.launch.MatchesVersion(r.CLIVersion, r.CLICommit) {
		return fmt.Errorf("Desktop registration and running CLI build differ; restart this runtime when idle")
	}
	return json.NewEncoder(cmd.OutOrStdout()).Encode(r)
}}

func init() { instanceCmd.AddCommand(instanceListCmd, instanceStatusCmd) }

func instanceStateDirectory(profile string) (string, bool) {
	selected, err := registeredInstance(profile)
	if err != nil {
		return "", true
	}
	if selected == nil {
		return "", false
	}
	dir, err := selected.store.Dir(selected.launch.InstanceID)
	return dir, err == nil
}
