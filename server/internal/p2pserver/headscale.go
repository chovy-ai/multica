package p2pserver

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
	"time"
)

// Headscale is a client for the Headscale REST API (grpc-gateway JSON, where
// uint64 fields are strings).
type Headscale struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

// HeadscaleNode is the part of a Headscale node this service uses.
type HeadscaleNode struct {
	ID      string `json:"id"`
	NodeKey string `json:"nodeKey"`
	Name    string `json:"name"`
	User    struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"user"`
}

type headscaleUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// headscaleUserName maps a Multica account to its Headscale user. Headscale
// user names must start with a letter.
func headscaleUserName(userID string) string { return "u-" + userID }

// EnsureUser returns the ID of the named user, creating it when missing.
func (h *Headscale) EnsureUser(ctx context.Context, name string) (string, error) {
	var listed struct {
		Users []headscaleUser `json:"users"`
	}
	if err := h.do(ctx, http.MethodGet, "/api/v1/user?name="+url.QueryEscape(name), nil, &listed); err != nil {
		return "", err
	}
	for _, u := range listed.Users {
		if u.Name == name {
			return u.ID, nil
		}
	}
	var created struct {
		User headscaleUser `json:"user"`
	}
	if err := h.do(ctx, http.MethodPost, "/api/v1/user", map[string]string{"name": name}, &created); err != nil {
		return "", err
	}
	if created.User.ID == "" {
		return "", errors.New("headscale: created user has no id")
	}
	return created.User.ID, nil
}

// CreatePreAuthKey issues a single-use key that registers one node as the user.
func (h *Headscale) CreatePreAuthKey(ctx context.Context, userID string, expires time.Time) (string, error) {
	var resp struct {
		PreAuthKey struct {
			Key string `json:"key"`
		} `json:"preAuthKey"`
	}
	body := map[string]any{
		"user":       userID,
		"reusable":   false,
		"ephemeral":  false,
		"expiration": expires.UTC().Format(time.RFC3339),
	}
	if err := h.do(ctx, http.MethodPost, "/api/v1/preauthkey", body, &resp); err != nil {
		return "", err
	}
	if resp.PreAuthKey.Key == "" {
		return "", errors.New("headscale: created pre-auth key is empty")
	}
	return resp.PreAuthKey.Key, nil
}

// Nodes lists the user's nodes, or every node when user is empty.
func (h *Headscale) Nodes(ctx context.Context, user string) ([]HeadscaleNode, error) {
	path := "/api/v1/node"
	if user != "" {
		path += "?user=" + url.QueryEscape(user)
	}
	var resp struct {
		Nodes []HeadscaleNode `json:"nodes"`
	}
	if err := h.do(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Nodes, nil
}

// DeleteNode removes a node, which signs it out of the tailnet.
func (h *Headscale) DeleteNode(ctx context.Context, id string) error {
	return h.do(ctx, http.MethodDelete, "/api/v1/node/"+url.PathEscape(id), nil, nil)
}

func (h *Headscale) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(h.BaseURL, "/")+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("headscale %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("headscale %s %s: %s: %s", method, path, res.Status, strings.TrimSpace(string(msg)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}
