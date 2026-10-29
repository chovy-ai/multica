package daemon

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"path/filepath"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

const (
	// p2pKeyFileName lives in the profile directory: profiles on one machine
	// may be signed in to different accounts, so each is its own device.
	p2pKeyFileName        = "p2p.key"
	p2pReregisterInterval = 6 * time.Hour
)

var p2pRegisterRetrySchedule = []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}

// P2P returns the running device link service, or nil when p2p is disabled
// or has not started. Features register protocol handlers and open streams
// to the account's other devices through it.
func (d *Daemon) P2P() *p2p.Service { return d.p2p.Load() }

func (d *Daemon) startP2P(ctx context.Context) error {
	dir, err := cli.ProfileDir(d.cfg.Profile)
	if err != nil {
		return err
	}
	key, err := p2p.LoadOrCreateKey(filepath.Join(dir, p2pKeyFileName))
	if err != nil {
		return err
	}
	registry := newP2PRegistryClient(d.cfg.P2PServerURL, d.client.Token)
	svc, err := p2p.Start(ctx, p2p.Config{
		Key:             key,
		Fetch:           func(ctx context.Context) ([]p2p.Peer, error) { return fetchP2PPeers(ctx, registry) },
		Port:            d.cfg.P2PPort,
		MDNSServiceName: p2p.DefaultMDNSServiceName,
		Logger:          d.logger,
	})
	if err != nil {
		return err
	}
	d.p2p.Store(svc)

	go func() {
		<-ctx.Done()
		d.p2p.Store(nil)
		svc.Close()
	}()
	go d.p2pRegistrationLoop(ctx, registry, svc, key.GetPublic())
	return nil
}

// p2pRegistrationLoop publishes the public key with backoff and re-publishes
// well inside the registry's 24h device TTL, so a live daemon never expires
// and a rename or registry cleanup heals. After each
// successful registration the allowlist is refreshed, which also tells the
// daemon its own entry is live.
func (d *Daemon) p2pRegistrationLoop(ctx context.Context, registry *p2pRegistryClient, svc *p2p.Service, pub crypto.PubKey) {
	raw, err := crypto.MarshalPublicKey(pub)
	if err != nil {
		d.logger.Warn("p2p: encode public key", "error", err)
		return
	}
	publicKey := base64.StdEncoding.EncodeToString(raw)
	for {
		for attempt := 0; ; attempt++ {
			err := registry.register(ctx, d.cfg.DaemonID, d.cfg.Profile, publicKey, d.cfg.DeviceName)
			if err == nil {
				d.logger.Info("p2p: identity registered", "peer_id", svc.ID().String())
				if err := svc.Refresh(ctx); err != nil && ctx.Err() == nil {
					d.logger.Warn("p2p: allowlist refresh failed", "error", err)
				}
				break
			}
			if ctx.Err() != nil {
				return
			}
			delay := p2pRegisterRetrySchedule[min(attempt, len(p2pRegisterRetrySchedule)-1)]
			d.logger.Warn("p2p: identity registration failed", "error", err, "retry_in", delay)
			if sleepWithContext(ctx, delay) != nil {
				return
			}
		}
		if sleepWithContext(ctx, p2pReregisterInterval) != nil {
			return
		}
	}
}

// fetchP2PPeers turns the registry's device list into the allowlist. Peer IDs
// are derived from the keys locally rather than taken from the response.
func fetchP2PPeers(ctx context.Context, registry *p2pRegistryClient) ([]p2p.Peer, error) {
	peers, err := registry.list(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]p2p.Peer, 0, len(peers))
	for _, p := range peers {
		raw, err := base64.StdEncoding.DecodeString(p.PublicKey)
		if err != nil {
			continue
		}
		id, err := p2p.PeerIDFromPublicKey(raw)
		if err != nil {
			continue
		}
		out = append(out, p2p.Peer{ID: id, DaemonID: p.DaemonID, Profile: p.Profile, DeviceName: p.DeviceName})
	}
	return out, nil
}

// p2pStatusResponse is served on the local health port. It is read-only;
// streams can only be opened in-process through P2P().
type p2pStatusResponse struct {
	Enabled bool `json:"enabled"`
	*p2p.Status
}

func (d *Daemon) p2pStatusHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		resp := p2pStatusResponse{}
		if svc := d.P2P(); svc != nil {
			st := svc.Status()
			resp = p2pStatusResponse{Enabled: true, Status: &st}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}
