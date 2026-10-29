package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// p2pDevice is one device profile of the daemon's account as listed by the
// p2p registry (cmd/p2p-server).
type p2pDevice struct {
	DaemonID   string `json:"daemon_id"`
	Profile    string `json:"profile"`
	PublicKey  string `json:"public_key"`
	DeviceName string `json:"device_name"`
}

// p2pRegistryClient talks to the p2p registry, a service separate from the
// Multica API server. It authenticates with the daemon's Multica login token,
// which the registry resolves through the API server's GET /api/me.
type p2pRegistryClient struct {
	baseURL string
	token   func() string
	http    *http.Client
}

func newP2PRegistryClient(baseURL string, token func() string) *p2pRegistryClient {
	return &p2pRegistryClient{baseURL: baseURL, token: token, http: &http.Client{Timeout: 30 * time.Second}}
}

func (c *p2pRegistryClient) register(ctx context.Context, daemonID, profile, publicKey, deviceName string) error {
	body, err := json.Marshal(map[string]string{
		"daemon_id":   daemonID,
		"profile":     profile,
		"public_key":  publicKey,
		"device_name": deviceName,
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

func (c *p2pRegistryClient) do(ctx context.Context, method, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.token())
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
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
