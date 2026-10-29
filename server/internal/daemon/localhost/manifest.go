package localhost

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ManifestDir is the directory Desktop packages next to the bundled CLI's
// `bin/` directory. It holds manifest.json and the sidecar entry.
const ManifestDir = "local-conversation-host"

// ManifestOverrideEnv lets the process that launches the daemon (Desktop in
// development, tests) name a manifest explicitly. It is read from the
// daemon's own environment, never from a network request.
const ManifestOverrideEnv = "MULTICA_LOCAL_HOST_MANIFEST"

// Manifest describes how to run the sidecar. Paths are relative to the
// manifest's directory. Electron is keyed by GOOS because the packaged
// executable name differs per platform.
type Manifest struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Electron        map[string]string `json:"electron"`
	// ClaudeEntry is the per-conversation Claude adapter entry.
	ClaudeEntry string `json:"claudeEntry"`
}

// Sidecar is a resolved, validated manifest.
type Sidecar struct {
	ProtocolVersion int
	Electron        string
	ClaudeEntry     string
}

// ErrNoManifest means this daemon binary was not installed by Desktop, so it
// does not offer local conversations.
var ErrNoManifest = errors.New("local conversation host manifest not found")

// Locate finds the sidecar for the daemon executable exe. The override
// manifest, when set, is trusted as given; the packaged manifest must keep the
// sidecar inside the same install as exe.
func Locate(exe string, getenv func(string) string) (Sidecar, error) {
	if override := getenv(ManifestOverrideEnv); override != "" {
		return load(override, "")
	}
	exe, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return Sidecar{}, fmt.Errorf("resolve daemon executable: %w", err)
	}
	path := filepath.Join(filepath.Dir(filepath.Dir(exe)), ManifestDir, "manifest.json")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return Sidecar{}, ErrNoManifest
	}
	root, ok := installRoot(exe)
	if !ok {
		return Sidecar{}, ErrNoManifest
	}
	return load(path, root)
}

// installRoot is the application install that contains exe: the enclosing
// `.app` bundle on macOS, otherwise the parent of the outermost `resources`
// directory (Windows and Linux Electron layouts).
func installRoot(exe string) (string, bool) {
	dir := filepath.Dir(exe)
	found := ""
	for {
		base := filepath.Base(dir)
		if runtime.GOOS == "darwin" && strings.HasSuffix(base, ".app") {
			return dir, true
		}
		if runtime.GOOS != "darwin" && strings.EqualFold(base, "resources") {
			found = filepath.Dir(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return found, found != ""
		}
		dir = parent
	}
}

func load(path, root string) (Sidecar, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Sidecar{}, fmt.Errorf("read local host manifest: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Sidecar{}, fmt.Errorf("parse local host manifest: %w", err)
	}
	if m.ProtocolVersion < 1 || m.ClaudeEntry == "" {
		return Sidecar{}, errors.New("local host manifest is incomplete")
	}
	electronRel := m.Electron[runtime.GOOS]
	if electronRel == "" {
		return Sidecar{}, fmt.Errorf("local host manifest has no Electron executable for %s", runtime.GOOS)
	}
	dir := filepath.Dir(path)
	electron, err := resolveFile(dir, electronRel, root)
	if err != nil {
		return Sidecar{}, fmt.Errorf("local host electron: %w", err)
	}
	claudeEntry, err := resolveFile(dir, m.ClaudeEntry, root)
	if err != nil {
		return Sidecar{}, fmt.Errorf("local host claude entry: %w", err)
	}
	return Sidecar{ProtocolVersion: m.ProtocolVersion, Electron: electron, ClaudeEntry: claudeEntry}, nil
}

func resolveFile(dir, rel, root string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", errors.New("path must be relative to the manifest")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	if root != "" {
		resolvedRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			return "", err
		}
		inside, err := filepath.Rel(resolvedRoot, path)
		if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
			return "", errors.New("path leaves the application install")
		}
	}
	return path, nil
}
