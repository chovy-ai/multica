package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalAPITokenFileLifecycle(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "profile", LocalAPITokenFile)

	if token, err := ReadLocalAPIToken(path); err != nil || token != "" {
		t.Fatalf("missing file: token=%q err=%v", token, err)
	}
	first, err := NewLocalAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteLocalAPIToken(path, first); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("token file must be owner-only: info=%v err=%v", info, err)
	}

	second, _ := NewLocalAPIToken()
	if second == first {
		t.Fatal("tokens must rotate")
	}
	if err := WriteLocalAPIToken(path, second); err != nil {
		t.Fatal(err)
	}
	// A predecessor exiting late must not delete its successor's token.
	RemoveLocalAPITokenIfOwned(path, first)
	if token, _ := ReadLocalAPIToken(path); token != second {
		t.Fatalf("successor token removed or changed: %q", token)
	}
	RemoveLocalAPITokenIfOwned(path, second)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("owner removal left the file: %v", err)
	}
}
