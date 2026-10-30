package runtimeinstance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func fixture(t *testing.T) Runtime {
	t.Helper()
	raw, err := os.ReadFile("testdata/runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var r Runtime
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	return r
}

func launchFixture(t *testing.T, r Runtime) Launch {
	t.Helper()
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "cli"), filepath.Join(dir, "electron"), filepath.Join(dir, "entry.js")}
	for _, p := range paths {
		if err := os.WriteFile(p, []byte("test-owned"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return Launch{SchemaVersion: 1, InstanceID: InstanceID, OwnerID: r.OwnerID, Kind: "development", AppPath: dir, CLIPath: paths[0], ElectronPath: paths[1], ClaudeEntryPath: paths[2], CLIVersion: r.CLIVersion, CLICommit: r.CLICommit[:9], Profile: ProfileName, APIURL: r.APIURL, ProtocolVersion: 2}
}

func TestRuntimeInstanceSingleRegistrationAndOwnedCleanup(t *testing.T) {
	s := New(t.TempDir())
	r := fixture(t)
	l := launchFixture(t, r)
	if err := s.PublishLaunch(l); err != nil {
		t.Fatal(err)
	}
	if err := l.ValidateExecutable(l.CLIPath); err != nil {
		t.Fatal(err)
	}
	if err := l.ValidateExecutable(l.ElectronPath); err == nil {
		t.Fatal("accepted another executable")
	}
	if err := s.PublishRuntime(r); err != nil {
		t.Fatal(err)
	}
	dir, _ := s.Dir(InstanceID)
	if runtime.GOOS != "windows" {
		for name, perm := range map[string]os.FileMode{"": 0o700, "launch.json": 0o600, "runtime.json": 0o600} {
			info, err := os.Stat(filepath.Join(dir, name))
			if err != nil || info.Mode().Perm() != perm {
				t.Fatalf("%s permissions: %v %v", name, info, err)
			}
		}
	}
	next := l
	next.OwnerID = strings.Repeat("3", 32)
	next.CLIPath = next.ElectronPath
	if err := s.PublishLaunch(next); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadLaunch(InstanceID)
	if err != nil || got.OwnerID != next.OwnerID {
		t.Fatal("latest Desktop did not win", got, err)
	}
	if err := s.PublishRuntime(r); err == nil {
		t.Fatal("old owner published after takeover")
	}
	successor := r
	successor.OwnerID = next.OwnerID
	successor.RunID = strings.Repeat("4", 32)
	if err := s.PublishRuntime(successor); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveRuntimeIfOwned(InstanceID, r.RunID, r.PID); err != nil {
		t.Fatal(err)
	}
	gotRuntime, err := s.ReadRuntime(InstanceID)
	if err != nil || gotRuntime.RunID != successor.RunID {
		t.Fatal("old cleanup removed successor")
	}
	if err := s.RemoveRuntimeIfOwned(InstanceID, successor.RunID, successor.PID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadRuntime(InstanceID); !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestRuntimeInstanceRejectsInvalidRegistration(t *testing.T) {
	s := New(t.TempDir())
	r := fixture(t)
	l := launchFixture(t, r)
	if _, err := s.Dir("../desktop"); err == nil {
		t.Fatal("accepted path traversal")
	}
	for _, change := range []func(*Launch){
		func(v *Launch) { v.ProtocolVersion = 99 }, func(v *Launch) { v.ClaudeEntryPath = "relative.js" },
		func(v *Launch) { v.Profile = "another" }, func(v *Launch) { v.OwnerID = "invalid" },
		func(v *Launch) { v.APIURL = "https://user:secret@example.test" },
	} {
		bad := l
		change(&bad)
		if err := s.PublishLaunch(bad); err == nil {
			t.Fatal("accepted invalid launch", bad)
		}
	}
	if err := s.PublishLaunch(l); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Runtime){
		func(v *Runtime) { v.Port = 65536 }, func(v *Runtime) { v.RunID = "invalid" },
		func(v *Runtime) { v.CLICommit = "unknown" }, func(v *Runtime) { v.APIURL = "https://other.test" },
		func(v *Runtime) { v.CLIVersion = "old" }, func(v *Runtime) { v.APIVersion = 1 },
	} {
		bad := r
		change(&bad)
		if err := s.PublishRuntime(bad); err == nil {
			t.Fatal("accepted invalid runtime", bad)
		}
	}
	dir, _ := s.Dir(InstanceID)
	path := filepath.Join(dir, "launch.json")
	for _, raw := range []string{"{}", "{} {}", strings.Repeat(" ", 65537)} {
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReadLaunch(InstanceID); err == nil {
			t.Fatal("accepted malformed JSON")
		}
	}
	if err := s.PublishLaunch(l); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReadLaunch(InstanceID); err == nil {
			t.Fatal("accepted public registration")
		}
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(l.CLIPath, path); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReadLaunch(InstanceID); err == nil {
			t.Fatal("accepted symlink registration")
		}
	}
}

func TestLaunchRequiresThePresentClaudeEntry(t *testing.T) {
	t.Parallel()

	launch := launchFixture(t, fixture(t))
	launch.ClaudeEntryPath = ""
	if err := launch.Validate(); err == nil {
		t.Fatal("launch without claude entry accepted")
	}
	launch.ClaudeEntryPath = filepath.Join(launch.AppPath, "missing-claude-host.js")
	if err := launch.Validate(); err != nil {
		t.Fatalf("absolute claude entry rejected: %v", err)
	}
	if err := launch.ValidateExecutable(launch.CLIPath); err == nil {
		t.Fatal("missing claude entry passed the executable check")
	}
	if err := os.WriteFile(launch.ClaudeEntryPath, []byte("test-owned"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := launch.ValidateExecutable(launch.CLIPath); err != nil {
		t.Fatalf("present claude entry rejected: %v", err)
	}
}
