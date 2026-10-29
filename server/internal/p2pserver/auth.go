// Package p2pserver is the device registry for daemon-to-daemon links. It runs
// separately from the Multica API server and never touches its database:
// callers present their Multica login token, which is checked against the
// API server's existing GET /api/me, and the registry only stores which
// libp2p keys belong to which account.
package p2pserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	// ErrUnauthorized means the API server rejected the token.
	ErrUnauthorized = errors.New("p2pserver: token rejected")
	// ErrAuthUnavailable means the API server could not be asked; requests
	// fail closed rather than being admitted unchecked.
	ErrAuthUnavailable = errors.New("p2pserver: account service unavailable")
)

// Authenticator resolves a Multica login token to the account's user ID.
type Authenticator interface {
	UserID(ctx context.Context, token string) (string, error)
}

// MeAuthenticator asks the API server who a token belongs to. Results are
// cached by token hash so steady-state traffic does not reach the API server;
// the token itself is never stored.
type MeAuthenticator struct {
	baseURL string
	http    *http.Client
	ttl     time.Duration
	now     func() time.Time

	mu    sync.Mutex
	cache map[string]cachedUser
}

type cachedUser struct {
	userID  string
	expires time.Time
}

// NewMeAuthenticator returns an authenticator against the API server at
// baseURL (e.g. https://api.multica.ai). ttl bounds how long a revoked token
// keeps working here.
func NewMeAuthenticator(baseURL string, ttl time.Duration) *MeAuthenticator {
	return &MeAuthenticator{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 10 * time.Second},
		ttl:     ttl,
		now:     time.Now,
		cache:   map[string]cachedUser{},
	}
}

// UserID implements Authenticator.
func (a *MeAuthenticator) UserID(ctx context.Context, token string) (string, error) {
	sum := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(sum[:])
	now := a.now()

	a.mu.Lock()
	if c, ok := a.cache[key]; ok && now.Before(c.expires) {
		a.mu.Unlock()
		return c.userID, nil
	}
	a.mu.Unlock()

	userID, err := a.fetch(ctx, token)
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	for k, c := range a.cache {
		if !now.Before(c.expires) {
			delete(a.cache, k)
		}
	}
	a.cache[key] = cachedUser{userID: userID, expires: now.Add(a.ttl)}
	a.mu.Unlock()
	return userID, nil
}

func (a *MeAuthenticator) fetch(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/api/me", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return "", ErrUnauthorized
	case resp.StatusCode != http.StatusOK:
		return "", fmt.Errorf("%w: status %d", ErrAuthUnavailable, resp.StatusCode)
	}
	var me struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&me); err != nil || me.ID == "" {
		return "", fmt.Errorf("%w: malformed /api/me response", ErrAuthUnavailable)
	}
	return me.ID, nil
}
