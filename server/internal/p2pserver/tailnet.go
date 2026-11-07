package p2pserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"tailscale.com/types/key"

	"github.com/multica-ai/multica/server/internal/tailnetid"
)

const (
	// tailnetKeyTTL bounds how long an issued pre-auth key can register a node.
	tailnetKeyTTL = 10 * time.Minute
	// tailnetAdmitTTL is how long the relay trusts its copy of the node list;
	// an unknown key refreshes it sooner, at most every tailnetAdmitRefresh.
	tailnetAdmitTTL     = time.Minute
	tailnetAdmitRefresh = 5 * time.Second
)

// Tailnet issues tailnet credentials to registered devices and keeps the
// control server's nodes in step with the registry.
type Tailnet struct {
	Headscale *Headscale
	// ControlURL is the control server address devices use.
	ControlURL string
	DERP       *DERP

	mu        sync.Mutex
	nodeKeys  map[key.NodePublic]struct{}
	fetchedAt time.Time
}

type tailnetRequest struct {
	PeerID string `json:"peer_id"`
}

// credentials issues a pre-auth key for a device already registered to the
// account, so a session alone cannot add nodes.
func (s *Server) tailnetCredentials(w http.ResponseWriter, r *http.Request, userID string) {
	if s.Tailnet == nil {
		writeError(w, http.StatusNotFound, "tailnet is not configured")
		return
	}
	var req tailnetRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodySize)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	owner, ok, err := s.Store.PeerOwner(r.Context(), strings.TrimSpace(req.PeerID), s.now().Add(-s.ttl()))
	if err != nil {
		s.logger().Warn("p2pserver: tailnet peer lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to check device")
		return
	}
	if !ok || owner != userID {
		writeError(w, http.StatusForbidden, "device is not registered to this account")
		return
	}
	hsUser, err := s.Tailnet.Headscale.EnsureUser(r.Context(), headscaleUserName(userID))
	if err != nil {
		s.logger().Warn("p2pserver: tailnet user failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "tailnet unavailable")
		return
	}
	authKey, err := s.Tailnet.Headscale.CreatePreAuthKey(r.Context(), hsUser, s.now().Add(tailnetKeyTTL))
	if err != nil {
		s.logger().Warn("p2pserver: tailnet key failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "tailnet unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"control_url": s.Tailnet.ControlURL,
		"auth_key":    authKey,
		"hostname":    tailnetid.Hostname(req.PeerID),
	})
}

// derpMap serves the relay map to the control server.
func (s *Server) tailnetDERPMap(w http.ResponseWriter, _ *http.Request) {
	if s.Tailnet == nil || s.Tailnet.DERP == nil {
		writeError(w, http.StatusNotFound, "tailnet is not configured")
		return
	}
	writeJSON(w, http.StatusOK, s.Tailnet.DERP.Map())
}

// Admit reports whether the control server knows a node key.
func (t *Tailnet) Admit(ctx context.Context, node key.NodePublic) (bool, error) {
	now := time.Now()
	t.mu.Lock()
	_, known := t.nodeKeys[node]
	age := now.Sub(t.fetchedAt)
	t.mu.Unlock()
	if (known && age < tailnetAdmitTTL) || (!known && age < tailnetAdmitRefresh) {
		return known, nil
	}
	nodes, err := t.Headscale.Nodes(ctx, "")
	if err != nil {
		if known {
			return true, nil
		}
		return false, err
	}
	keys := make(map[key.NodePublic]struct{}, len(nodes))
	for _, n := range nodes {
		var k key.NodePublic
		if k.UnmarshalText([]byte(n.NodeKey)) == nil {
			keys[k] = struct{}{}
		}
	}
	t.mu.Lock()
	t.nodeKeys, t.fetchedAt = keys, now
	t.mu.Unlock()
	_, known = keys[node]
	return known, nil
}

// forget signs a removed device's node out of the tailnet.
func (t *Tailnet) forget(ctx context.Context, userID, peerID string) error {
	nodes, err := t.Headscale.Nodes(ctx, headscaleUserName(userID))
	if err != nil {
		return err
	}
	host := tailnetid.Hostname(peerID)
	for _, n := range nodes {
		if n.Name == host {
			if err := t.Headscale.DeleteNode(ctx, n.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// pruneTailnet removes nodes whose device left the registry, as purged
// devices do.
func (s *Server) pruneTailnet(ctx context.Context) (int, error) {
	nodes, err := s.Tailnet.Headscale.Nodes(ctx, "")
	if err != nil {
		return 0, err
	}
	since := s.now().Add(-s.ttl())
	hosts := map[string]map[string]bool{}
	removed := 0
	for _, n := range nodes {
		userID, ok := strings.CutPrefix(n.User.Name, "u-")
		if !ok {
			continue
		}
		live, listed := hosts[userID]
		if !listed {
			devices, err := s.Store.List(ctx, userID, since)
			if err != nil {
				return removed, err
			}
			live = make(map[string]bool, len(devices))
			for _, d := range devices {
				live[tailnetid.Hostname(d.PeerID)] = true
			}
			hosts[userID] = live
		}
		if live[n.Name] {
			continue
		}
		if err := s.Tailnet.Headscale.DeleteNode(ctx, n.ID); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}
