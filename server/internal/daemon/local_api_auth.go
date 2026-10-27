package daemon

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

// authorizeLocalRequest admits only requests a local, non-browser client could
// make: the bearer token, a loopback Host (defeats DNS rebinding), and no
// Origin header (browsers always send one on cross-origin requests).
func (d *Daemon) authorizeLocalRequest(r *http.Request) bool {
	if d.cfg.LocalAPIToken == "" || r.Header.Get("Origin") != "" {
		return false
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}
	switch strings.ToLower(strings.Trim(host, "[]")) {
	case "127.0.0.1", "localhost", "::1":
	default:
		return false
	}
	presented, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(presented), []byte(d.cfg.LocalAPIToken)) == 1
}
