package mobilelink

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
	ma "github.com/multiformats/go-multiaddr"
)

// registry holds a mobile login's short-lived registry credential. It never
// sends the Multica login token to devices or to the relay transport.
type registry struct {
	url, session string
	expires      time.Time
	mu           sync.Mutex
	http         *http.Client

	// loginMu is separate because mu is held across registry requests, and a
	// token refresh must not wait on a slow one.
	loginMu sync.Mutex
	login   string
}

func (r *registry) setLogin(token string) {
	r.loginMu.Lock()
	r.login = token
	r.loginMu.Unlock()
}

func (r *registry) currentLogin() string {
	r.loginMu.Lock()
	defer r.loginMu.Unlock()
	return r.login
}

func (r *registry) call(ctx context.Context, method, path string, body, out any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if r.session == "" || time.Until(r.expires) < 10*time.Minute {
			var issued struct {
				Token   string    `json:"session_token"`
				Expires time.Time `json:"expires_at"`
			}
			status, err := r.send(ctx, "POST", "/v1/sessions", r.currentLogin(), nil, &issued)
			if err != nil {
				return err
			}
			if status != http.StatusOK || issued.Token == "" {
				return fmt.Errorf("registry_auth_failed: HTTP %d", status)
			}
			r.session, r.expires = issued.Token, issued.Expires
		}
		status, err := r.send(ctx, method, path, r.session, body, out)
		if status == http.StatusUnauthorized && attempt == 0 {
			r.session = ""
			continue
		}
		if err != nil {
			return err
		}
		if status < 200 || status >= 300 {
			return registryStatusError(status)
		}
		return nil
	}
	return fmt.Errorf("registry_auth_failed: session expired")
}

// registryStatusError is a registry response outside 2xx.
type registryStatusError int

func (e registryStatusError) Error() string {
	return fmt.Sprintf("registry_request_failed: HTTP %d", int(e))
}

// tailnet asks for credentials that register this phone's tailnet node. A
// registry without a control server answers 404.
func (r *registry) tailnet(ctx context.Context, peerID string) (p2p.TailnetCredentials, error) {
	var resp struct {
		ControlURL string `json:"control_url"`
		AuthKey    string `json:"auth_key"`
	}
	err := r.call(ctx, "POST", "/v1/tailnet", map[string]string{"peer_id": peerID}, &resp)
	var status registryStatusError
	if errors.As(err, &status) && status == http.StatusNotFound {
		return p2p.TailnetCredentials{}, p2p.ErrTailnetUnavailable
	}
	if err != nil {
		return p2p.TailnetCredentials{}, err
	}
	if resp.ControlURL == "" || resp.AuthKey == "" {
		return p2p.TailnetCredentials{}, errors.New("registry_request_failed: incomplete tailnet credentials")
	}
	return p2p.TailnetCredentials{ControlURL: resp.ControlURL, AuthKey: resp.AuthKey}, nil
}

func (r *registry) send(ctx context.Context, method, path, token string, body, out any) (int, error) {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return 0, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, r.url+path, bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := r.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 && out != nil {
		err = json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	}
	return res.StatusCode, err
}

func (r *registry) peers(ctx context.Context) ([]p2p.Peer, error) {
	var response struct {
		Devices []struct {
			Key     string   `json:"public_key"`
			Name    string   `json:"device_name"`
			ID      string   `json:"daemon_id"`
			Profile string   `json:"profile"`
			Addrs   []string `json:"addrs"`
		} `json:"devices"`
	}
	if err := r.call(ctx, "GET", "/v1/devices", nil, &response); err != nil {
		return nil, err
	}
	out := make([]p2p.Peer, 0, len(response.Devices))
	for _, device := range response.Devices {
		key, err := base64.StdEncoding.DecodeString(device.Key)
		if err != nil {
			continue
		}
		id, err := p2p.PeerIDFromPublicKey(key)
		if err != nil {
			continue
		}
		entry := p2p.Peer{ID: id, DeviceName: device.Name, DaemonID: device.ID, Profile: device.Profile}
		for _, raw := range device.Addrs {
			if a, err := ma.NewMultiaddr(raw); err == nil {
				entry.RegisteredAddrs = append(entry.RegisteredAddrs, a)
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func (r *registry) relay(ctx context.Context) (*peer.AddrInfo, error) {
	var response struct {
		Relay *struct {
			ID    string   `json:"peer_id"`
			Addrs []string `json:"addrs"`
		} `json:"relay"`
	}
	if err := r.call(ctx, "GET", "/v1/config", nil, &response); err != nil {
		return nil, err
	}
	if response.Relay == nil {
		return nil, nil
	}
	id, err := peer.Decode(response.Relay.ID)
	if err != nil {
		return nil, err
	}
	out := &peer.AddrInfo{ID: id}
	for _, raw := range response.Relay.Addrs {
		if a, err := ma.NewMultiaddr(strings.TrimSpace(raw)); err == nil {
			out.Addrs = append(out.Addrs, a)
		}
	}
	if len(out.Addrs) == 0 {
		return nil, fmt.Errorf("invalid_response: relay has no usable address")
	}
	return out, nil
}
