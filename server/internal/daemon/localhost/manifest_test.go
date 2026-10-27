package localhost

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

// packagedLayout mirrors where electron-builder places the bundled CLI.
func packagedLayout(t *testing.T) (root, exe, electron string) {
	t.Helper()
	base := t.TempDir()
	if runtime.GOOS == "darwin" {
		root = filepath.Join(base, "Multica.app")
		electron = filepath.Join(root, "Contents", "MacOS", "Multica")
		exe = filepath.Join(root, "Contents", "Resources", "app.asar.unpacked", "resources", "bin", "multica")
	} else {
		root = filepath.Join(base, "Multica")
		electron = filepath.Join(root, "multica-desktop")
		exe = filepath.Join(root, "resources", "app.asar.unpacked", "resources", "bin", "multica")
	}
	writeFile(t, electron, "electron")
	writeFile(t, exe, "cli")
	return root, exe, electron
}

func manifestPath(exe string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(exe)), ManifestDir, "manifest.json")
}

func relTo(t *testing.T, from, to string) string {
	t.Helper()
	rel, err := filepath.Rel(from, to)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.ToSlash(rel)
}

func noEnv(string) string { return "" }

func manifestJSON(version int, entry, electron string) string {
	data, _ := json.Marshal(Manifest{ProtocolVersion: version, Entry: entry, Electron: map[string]string{runtime.GOOS: electron}})
	return string(data)
}

func TestLocatePackagedSidecar(t *testing.T) {
	_, exe, electron := packagedLayout(t)
	dir := filepath.Dir(manifestPath(exe))
	writeFile(t, filepath.Join(dir, "index.mjs"), "")
	writeFile(t, manifestPath(exe), manifestJSON(2, "index.mjs", relTo(t, dir, electron)))

	got, err := Locate(exe, noEnv)
	if err != nil {
		t.Fatalf("Locate() = %v", err)
	}
	wantElectron, _ := filepath.EvalSymlinks(electron)
	if got.Electron != wantElectron || filepath.Base(got.Entry) != "index.mjs" || got.ProtocolVersion != 2 {
		t.Fatalf("unexpected sidecar: %+v", got)
	}
}

func TestLocateWithoutManifestIsUnsupported(t *testing.T) {
	_, exe, _ := packagedLayout(t)
	if _, err := Locate(exe, noEnv); !errors.Is(err, ErrNoManifest) {
		t.Fatalf("Locate() = %v, want ErrNoManifest", err)
	}
}

func TestLocateRejectsElectronOutsideInstall(t *testing.T) {
	_, exe, _ := packagedLayout(t)
	outside := filepath.Join(t.TempDir(), "evil")
	writeFile(t, outside, "evil")
	dir := filepath.Dir(manifestPath(exe))
	writeFile(t, filepath.Join(dir, "index.mjs"), "")
	writeFile(t, manifestPath(exe), manifestJSON(2, "index.mjs", relTo(t, dir, outside)))

	if _, err := Locate(exe, noEnv); err == nil {
		t.Fatal("Locate() accepted an Electron binary outside the application install")
	}
}

func TestLocateRejectsAbsoluteAndMissingPaths(t *testing.T) {
	_, exe, electron := packagedLayout(t)
	dir := filepath.Dir(manifestPath(exe))
	for _, body := range []string{
		manifestJSON(2, "index.mjs", filepath.ToSlash(electron)),
		manifestJSON(2, "missing.mjs", relTo(t, dir, electron)),
		manifestJSON(0, "index.mjs", "x"),
		`{"protocolVersion":2,"entry":"index.mjs","electron":{"plan9":"x"}}`,
	} {
		writeFile(t, manifestPath(exe), body)
		if _, err := Locate(exe, noEnv); err == nil || errors.Is(err, ErrNoManifest) {
			t.Fatalf("Locate(%s) = %v, want a validation error", body, err)
		}
	}
}

func TestLocateHonorsLauncherOverride(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "node"), "")
	writeFile(t, filepath.Join(dir, "entry.mjs"), "")
	path := filepath.Join(dir, "manifest.json")
	writeFile(t, path, manifestJSON(2, "entry.mjs", "node"))

	got, err := Locate(filepath.Join(t.TempDir(), "multica"), func(key string) string {
		if key == ManifestOverrideEnv {
			return path
		}
		return ""
	})
	if err != nil || filepath.Base(got.Entry) != "entry.mjs" {
		t.Fatalf("Locate() = %+v, %v", got, err)
	}
}
