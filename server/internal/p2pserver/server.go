package p2pserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	cryptopb "github.com/libp2p/go-libp2p/core/crypto/pb"
	"github.com/libp2p/go-libp2p/core/peer"
)

const (
	// DefaultDeviceTTL is how long a registration stays valid without being
	// refreshed. The API server never tells this service about sign-outs or
	// deleted accounts, so stale devices age out instead.
	DefaultDeviceTTL = 24 * time.Hour

	maxFieldLen = 200
	maxBodySize = 16 << 10
)

// Server serves the device registry API:
//
//	POST   /v1/devices                         register or refresh this device
//	GET    /v1/devices                         list the account's live devices
//	DELETE /v1/devices?daemon_id=..&profile=.. remove a device
//	GET    /healthz
type Server struct {
	Auth      Authenticator
	Store     *Store
	DeviceTTL time.Duration
	Logger    *slog.Logger
	Now       func() time.Time
}

// Handler returns the HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /v1/devices", s.authed(s.register))
	mux.HandleFunc("GET /v1/devices", s.authed(s.list))
	mux.HandleFunc("DELETE /v1/devices", s.authed(s.remove))
	return mux
}

// RunPurge deletes expired devices every interval until ctx ends.
func (s *Server) RunPurge(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.Store.PurgeBefore(ctx, s.now().Add(-s.ttl())); err != nil {
				s.logger().Warn("p2pserver: purge failed", "error", err)
			} else if n > 0 {
				s.logger().Info("p2pserver: purged expired devices", "count", n)
			}
		}
	}
}

func (s *Server) ttl() time.Duration {
	if s.DeviceTTL > 0 {
		return s.DeviceTTL
	}
	return DefaultDeviceTTL
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

type authedHandler func(w http.ResponseWriter, r *http.Request, userID string)

func (s *Server) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || strings.TrimSpace(token) == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		userID, err := s.Auth.UserID(r.Context(), strings.TrimSpace(token))
		switch {
		case errors.Is(err, ErrUnauthorized):
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		case err != nil:
			// Never log the token; the error carries only status details.
			s.logger().Warn("p2pserver: account check failed", "error", err)
			writeError(w, http.StatusServiceUnavailable, "account service unavailable")
			return
		}
		h(w, r, userID)
	}
}

type registerRequest struct {
	DaemonID string `json:"daemon_id"`
	Profile  string `json:"profile"`
	// PublicKey is a libp2p protobuf-encoded ed25519 public key, base64
	// (standard) encoded. The peer ID is derived from it here.
	PublicKey  string `json:"public_key"`
	DeviceName string `json:"device_name"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request, userID string) {
	var req registerRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodySize)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.DaemonID = strings.TrimSpace(req.DaemonID)
	if req.DaemonID == "" || len(req.DaemonID) > maxFieldLen {
		writeError(w, http.StatusBadRequest, "daemon_id is required")
		return
	}
	publicKey, peerID, ok := parsePublicKey(req.PublicKey)
	if !ok {
		writeError(w, http.StatusBadRequest, "public_key must be a base64 libp2p ed25519 public key")
		return
	}
	d, err := s.Store.Upsert(r.Context(), Device{
		UserID:     userID,
		DaemonID:   req.DaemonID,
		Profile:    truncate(strings.TrimSpace(req.Profile)),
		PeerID:     peerID,
		PublicKey:  publicKey,
		DeviceName: truncate(strings.TrimSpace(req.DeviceName)),
	})
	if err != nil {
		s.logger().Warn("p2pserver: register failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to register device")
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request, userID string) {
	devices, err := s.Store.List(r.Context(), userID, s.now().Add(-s.ttl()))
	if err != nil {
		s.logger().Warn("p2pserver: list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list devices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request, userID string) {
	daemonID := strings.TrimSpace(r.URL.Query().Get("daemon_id"))
	if daemonID == "" {
		writeError(w, http.StatusBadRequest, "daemon_id is required")
		return
	}
	found, err := s.Store.Delete(r.Context(), userID, daemonID, strings.TrimSpace(r.URL.Query().Get("profile")))
	if err != nil {
		s.logger().Warn("p2pserver: delete failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to delete device")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// parsePublicKey accepts only ed25519 keys, the type daemons generate, and
// returns the canonical encoding with its peer ID.
func parsePublicKey(encoded string) (canonical, peerID string, ok bool) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	pub, err := crypto.UnmarshalPublicKey(raw)
	if err != nil || pub.Type() != cryptopb.KeyType_Ed25519 {
		return "", "", false
	}
	id, err := peer.IDFromPublicKey(pub)
	if err != nil {
		return "", "", false
	}
	out, err := crypto.MarshalPublicKey(pub)
	if err != nil {
		return "", "", false
	}
	return base64.StdEncoding.EncodeToString(out), id.String(), true
}

func truncate(s string) string {
	if r := []rune(s); len(r) > maxFieldLen {
		return string(r[:maxFieldLen])
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
