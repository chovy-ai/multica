package mobilelink

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/p2p"
)

func TestRegistryTailnetCredentials(t *testing.T) {
	configured := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/sessions":
			json.NewEncoder(w).Encode(map[string]any{"session_token": "sess", "expires_at": time.Now().Add(24 * time.Hour)})
		case "/v1/tailnet":
			if !configured {
				http.Error(w, "tailnet is not configured", http.StatusNotFound)
				return
			}
			var req struct {
				PeerID string `json:"peer_id"`
			}
			json.NewDecoder(r.Body).Decode(&req)
			if r.Header.Get("Authorization") != "Bearer sess" || req.PeerID != "12D3KooWphone" {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"control_url": "http://control:8091", "auth_key": "hskey"})
		}
	}))
	defer srv.Close()
	r := &registry{url: srv.URL, login: "tok", http: srv.Client()}

	creds, err := r.tailnet(context.Background(), "12D3KooWphone")
	if err != nil || creds != (p2p.TailnetCredentials{ControlURL: "http://control:8091", AuthKey: "hskey"}) {
		t.Fatalf("credentials = %+v, %v", creds, err)
	}
	configured = false
	if _, err := r.tailnet(context.Background(), "12D3KooWphone"); !errors.Is(err, p2p.ErrTailnetUnavailable) {
		t.Fatalf("without a control server: %v, want ErrTailnetUnavailable", err)
	}
}
