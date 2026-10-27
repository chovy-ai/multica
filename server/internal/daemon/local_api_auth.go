package daemon

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/localhost"
)

// LocalAPITokenFile is the per-profile file holding the bearer token that local
// clients (the CLI, Desktop) present to the daemon's loopback endpoints. It is
// rotated on every daemon start.
const LocalAPITokenFile = "local-api.token"

// NewLocalAPIToken returns a fresh random bearer token.
func NewLocalAPIToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate local API token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// WriteLocalAPIToken atomically replaces the token file with owner-only access.
func WriteLocalAPIToken(path, token string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".local-api.token-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ReadLocalAPIToken returns the token in path, or "" when it is absent.
func ReadLocalAPIToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// RemoveLocalAPITokenIfOwned deletes the token file only when it still holds
// token, so a daemon exiting late never removes its successor's token.
func RemoveLocalAPITokenIfOwned(path, token string) {
	if data, err := os.ReadFile(path); err == nil && bytes.Equal(bytes.TrimSpace(data), []byte(token)) {
		_ = os.Remove(path)
	}
}

// authorizeLocalRequest gates loopback control endpoints; see localhost.Authorize.
func (d *Daemon) authorizeLocalRequest(r *http.Request) bool {
	return localhost.Authorize(r, d.cfg.LocalAPIToken)
}
