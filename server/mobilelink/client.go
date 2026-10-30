// Package mobilelink exposes the account's existing libp2p device transport to
// iOS through gomobile. It runs no agent and accepts no inbound conversations.
package mobilelink

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

const deviceProtocol = "/multica/local-api/1"

type configuration struct {
	RegistryURL string `json:"registryUrl"`
	APIURL      string `json:"apiUrl"`
	Token       string `json:"token"`
	UserID      string `json:"userId"`
	StoragePath string `json:"storagePath"`
	DeviceName  string `json:"deviceName"`
}

// Client owns a foreground mobile device link. Close releases every socket and
// clears the registry credential together; callers replace it on account change.
type Client struct {
	cfg         configuration
	ctx         context.Context
	cancel      context.CancelFunc
	svc         *p2p.Service
	registry    *registry
	server      *http.Server
	endpoint    string
	token       string
	mu          sync.Mutex
	transports  map[peer.ID]*http.Transport
	connections map[net.Conn]struct{}
	once        sync.Once
}

// Start accepts JSON so the binding has no platform-specific DTO dependency.
func Start(configJSON string) (*Client, error) {
	var cfg configuration
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return nil, err
	}
	for _, raw := range []string{cfg.RegistryURL, cfg.APIURL} {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return nil, fmt.Errorf("invalid_configuration: invalid service URL")
		}
	}
	if cfg.Token == "" || cfg.UserID == "" || !filepath.IsAbs(cfg.StoragePath) {
		return nil, fmt.Errorf("invalid_configuration: login and storage are required")
	}
	if err := os.MkdirAll(cfg.StoragePath, 0700); err != nil {
		return nil, err
	}
	// Partition identities by account: signing in as another user must never
	// register the old account's peer key under the new account.
	keyPath := filepath.Join(cfg.StoragePath, hex.EncodeToString([]byte(cfg.UserID))+".key")
	key, err := p2p.LoadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{cfg: cfg, ctx: ctx, cancel: cancel, transports: map[peer.ID]*http.Transport{}, connections: map[net.Conn]struct{}{}}
	c.registry = &registry{url: strings.TrimRight(cfg.RegistryURL, "/"), login: cfg.Token, http: &http.Client{Timeout: 30 * time.Second}}
	changed := make(chan struct{}, 1)
	c.svc, err = p2p.Start(ctx, p2p.Config{Key: key, Fetch: c.registry.peers, Relay: c.registry.relay,
		RefreshInterval: 15 * time.Second, OnAddrsChanged: func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		}})
	if err != nil {
		cancel()
		return nil, err
	}
	publicKey, err := crypto.MarshalPublicKey(key.GetPublic())
	if err != nil {
		c.Close()
		return nil, err
	}
	if err := c.register(publicKey); err != nil {
		c.Close()
		return nil, err
	}
	_ = c.svc.Refresh(ctx)
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		c.Close()
		return nil, err
	}
	c.token = hex.EncodeToString(secret)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		c.Close()
		return nil, err
	}
	c.endpoint = "http://" + ln.Addr().String()
	c.server = &http.Server{Handler: http.HandlerFunc(c.serve), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = c.server.Serve(ln) }()
	go func() {
		tick := time.NewTicker(6 * time.Hour)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-changed:
			case <-tick.C:
			}
			// Failed registrations retry on the next refresh, without retaining
			// credentials from a stopped foreground client.
			for ctx.Err() == nil {
				if c.register(publicKey) == nil {
					break
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(15 * time.Second):
				}
			}
		}
	}()
	return c, nil
}

func (c *Client) register(publicKey []byte) error {
	return c.registry.call(c.ctx, "POST", "/v1/devices", map[string]any{
		"daemon_id": "ios-" + c.svc.ID().String(), "profile": "mobile", "public_key": base64.StdEncoding.EncodeToString(publicKey),
		"device_name": c.cfg.DeviceName, "addrs": c.svc.AdvertisedAddrs(),
	}, nil)
}

// Endpoint returns a private loopback credential, never the Multica login token.
func (c *Client) Endpoint() string {
	data, _ := json.Marshal(map[string]string{"url": c.endpoint, "token": c.token})
	return string(data)
}

// Close also closes hijacked WebSockets, which http.Server.Close does not own.
func (c *Client) Close() {
	c.once.Do(func() {
		c.cancel()
		if c.server != nil {
			_ = c.server.Close()
		}
		c.mu.Lock()
		connections := make([]net.Conn, 0, len(c.connections))
		transports := make([]*http.Transport, 0, len(c.transports))
		for conn := range c.connections {
			connections = append(connections, conn)
		}
		for _, transport := range c.transports {
			transports = append(transports, transport)
		}
		c.mu.Unlock()
		for _, transport := range transports {
			transport.CloseIdleConnections()
		}
		for _, conn := range connections {
			_ = conn.Close()
		}
		if c.svc != nil {
			_ = c.svc.Close()
		}
	})
}

func (c *Client) serve(w http.ResponseWriter, r *http.Request) {
	// Native fetch and WebSocket can both supply headers. Unlike the desktop
	// browser entry no ticket or login token is placed in a URL.
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+c.token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"version": 2, "peer_id": c.svc.ID().String()})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/devices" {
		devices := []map[string]any{}
		for _, p := range c.svc.Peers() {
			if p.Profile == "mobile" && strings.HasPrefix(p.DaemonID, "ios-") {
				continue
			}
			devices = append(devices, map[string]any{"peer_id": p.ID.String(), "device_name": p.DeviceName,
				"connected": p.Connected, "available": p.Connected && c.svc.SupportsProtocol(p.ID, deviceProtocol), "connection": p.Connection})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"devices": devices})
		return
	}
	id, inner, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/devices/"), "/")
	peerID, err := peer.Decode(id)
	if !strings.HasPrefix(r.URL.Path, "/devices/") || !ok || err != nil || !strings.HasPrefix(inner, "local/v2/") || strings.Contains(inner, "..") {
		http.NotFound(w, r)
		return
	}
	if _, known := c.svc.Peer(peerID); !known {
		writeError(w, "device_unknown", http.StatusNotFound)
		return
	}
	if r.Header.Get("X-Workspace-ID") == "" {
		writeError(w, "invalid_request", http.StatusBadRequest)
		return
	}
	// The native client owns account/API identity. Never trust a caller to
	// replace it using a scope header or arbitrary proxy target.
	r.Header.Set("X-Multica-User-ID", c.cfg.UserID)
	r.Header.Set("X-Multica-API-Origin", c.cfg.APIURL)
	r.Header.Del("Authorization")
	r.URL.Path, r.URL.RawPath = "/"+inner, ""
	c.mu.Lock()
	transport := c.transports[peerID]
	if transport == nil {
		transport = &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			conn, err := c.svc.Dial(ctx, peerID, deviceProtocol)
			if err != nil {
				return nil, err
			}
			tracked := &trackedConnection{Conn: conn, owner: c}
			c.mu.Lock()
			c.connections[tracked] = struct{}{}
			c.mu.Unlock()
			return tracked, nil
		}, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 30 * time.Second}
		c.transports[peerID] = transport
	}
	c.mu.Unlock()
	if c.svc.Connection(peerID) == p2p.ConnectionRelayed && r.ContentLength > 5<<20 {
		writeError(w, "relay_transfer_limited", http.StatusRequestEntityTooLarge)
		return
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.Out.URL.Scheme, p.Out.URL.Host, p.Out.Host = "http", "device-link", "device-link"
	}, Transport: transport, ModifyResponse: func(response *http.Response) error {
		if response.ContentLength > 5<<20 && c.svc.Connection(peerID) == p2p.ConnectionRelayed {
			_ = response.Body.Close()
			return fmt.Errorf("relay_transfer_limited")
		}
		return nil
	},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			writeError(w, "device_unreachable", http.StatusBadGateway)
		}}
	proxy.ServeHTTP(w, r)
}

type trackedConnection struct {
	net.Conn
	owner *Client
	once  sync.Once
}

func (c *trackedConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.connections, c); c.owner.mu.Unlock() })
	return err
}

func writeError(w http.ResponseWriter, kind string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"kind": kind, "message": kind}})
}
