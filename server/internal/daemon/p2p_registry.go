package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// p2pDevice is one device profile of the daemon's account as listed by the
// p2p registry (cmd/p2p-server).
type p2pDevice struct {
	DaemonID   string   `json:"daemon_id"`
	Profile    string   `json:"profile"`
	PublicKey  string   `json:"public_key"`
	DeviceName string   `json:"device_name"`
	Addrs      []string `json:"addrs"`
}

// p2pRelayInfo is the registry's relay node, from GET /v1/config.
type p2pRelayInfo struct {
	PeerID string   `json:"peer_id"`
	Addrs  []string `json:"addrs"`
}

var (
	// errP2PUnauthorized is a 401 from the registry.
	errP2PUnauthorized = errors.New("p2p registry: unauthorized")
	// errP2PNotFound is a 404 from the registry.
	errP2PNotFound = errors.New("p2p registry: not found")
)

// p2pSessionRenewMargin renews a session this long before it expires.
const p2pSessionRenewMargin = 10 * time.Minute

// p2pRegistryClient talks to the p2p registry, a service separate from the
// Multica API server. The daemon's Multica login token is sent only to
// exchange it for a registry session token (POST /v1/sessions); every other
// call uses the session, so the login token crosses the network about once
// a day even when the registry is served over plain HTTP.
type p2pRegistryClient struct {
	baseURL string
	token   func() string
	http    *http.Client
	now     func() time.Time

	mu      sync.Mutex
	session string
	expires time.Time
}

func newP2PRegistryClient(baseURL string, token func() string) *p2pRegistryClient {
	return &p2pRegistryClient{baseURL: baseURL, token: token, http: &http.Client{Timeout: 30 * time.Second}, now: time.Now}
}

func (c *p2pRegistryClient) register(ctx context.Context, daemonID, profile, publicKey, deviceName string, addrs []string) error {
	if addrs == nil {
		addrs = []string{}
	}
	body, err := json.Marshal(map[string]any{
		"daemon_id":   daemonID,
		"profile":     profile,
		"public_key":  publicKey,
		"device_name": deviceName,
		"addrs":       addrs,
	})
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, "/v1/devices", body, nil)
}

func (c *p2pRegistryClient) list(ctx context.Context) ([]p2pDevice, error) {
	var resp struct {
		Devices []p2pDevice `json:"devices"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/devices", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Devices, nil
}

func (c *p2pRegistryClient) relay(ctx context.Context) (*p2pRelayInfo, error) {
	var resp struct {
		Relay *p2pRelayInfo `json:"relay"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/config", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Relay, nil
}

// remove deletes a device of this account from the registry.
func (c *p2pRegistryClient) remove(ctx context.Context, daemonID, profile string) error {
	q := url.Values{"daemon_id": {daemonID}, "profile": {profile}}
	return c.do(ctx, http.MethodDelete, "/v1/devices?"+q.Encode(), nil, nil)
}

// do calls a session-authenticated endpoint, obtaining a session first and
// once more if the registry rejects it (expired, or the registry lost it).
func (c *p2pRegistryClient) do(ctx context.Context, method, path string, body []byte, out any) error {
	session, err := c.sessionToken(ctx, false)
	if err != nil {
		return err
	}
	err = c.send(ctx, method, path, session, body, out)
	if !errors.Is(err, errP2PUnauthorized) {
		return err
	}
	if session, err = c.sessionToken(ctx, true); err != nil {
		return err
	}
	return c.send(ctx, method, path, session, body, out)
}

func (c *p2pRegistryClient) sessionToken(ctx context.Context, renew bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !renew && c.session != "" && c.now().Before(c.expires.Add(-p2pSessionRenewMargin)) {
		return c.session, nil
	}
	var resp struct {
		SessionToken string    `json:"session_token"`
		ExpiresAt    time.Time `json:"expires_at"`
	}
	if err := c.send(ctx, http.MethodPost, "/v1/sessions", c.token(), nil, &resp); err != nil {
		c.session = ""
		return "", err
	}
	if resp.SessionToken == "" {
		return "", fmt.Errorf("p2p registry: empty session token")
	}
	c.session, c.expires = resp.SessionToken, resp.ExpiresAt
	return c.session, nil
}

func (c *p2pRegistryClient) send(ctx context.Context, method, path, bearer string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%w: %s %s", errP2PUnauthorized, method, path)
	}
	if resp.StatusCode == http.StatusNotFound {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%w: %s %s", errP2PNotFound, method, path)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("p2p registry %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
