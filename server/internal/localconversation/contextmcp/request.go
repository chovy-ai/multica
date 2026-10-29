package contextmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const writeTimeout = 15 * time.Second

// OperationError is a failed Multica operation: the server's business code
// and message, with the credential redacted.
type OperationError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Status  int            `json:"http_status,omitempty"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *OperationError) Error() string { return e.Message }

// errUnconfirmed reports a write whose response could not be read.
var errUnconfirmed = errors.New("The server did not confirm the operation result. Inspect current state before repeating a write.")

// Request performs one authenticated workspace API call with a JSON body
// and returns the decoded response. A list with a next cursor header is
// returned as a page.
func (c *CloudClient) Request(ctx context.Context, method, path string, body any) (any, error) {
	token := c.Token()
	if token == "" {
		return nil, errCloudUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.APIURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Workspace-ID", c.WorkspaceID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, err := client.Do(req)
	if err != nil {
		if method == http.MethodGet {
			return nil, fmt.Errorf("Multica request failed: %s", redact(err.Error(), token))
		}
		return nil, errUnconfirmed
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxCloudBody))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, operationError(res.StatusCode, data, token)
	}
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	var value any
	if err != nil || json.Unmarshal(data, &value) != nil {
		return nil, errUnconfirmed
	}
	if next := res.Header.Get("X-Agent-Tasks-Next-Cursor"); next != "" {
		if list, ok := value.([]any); ok {
			return map[string]any{"items": list, "has_more": true, "next_cursor": next}, nil
		}
	}
	return value, nil
}

func operationError(status int, body []byte, token string) error {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	code := fmt.Sprintf("http_%d", status)
	if v, ok := raw["code"].(string); ok {
		code = truncate(v, 200)
	}
	message := "Multica operation failed"
	if v, ok := raw["error"].(string); ok {
		message = v
	} else if v, ok := raw["message"].(string); ok {
		message = v
	}
	details := map[string]any{}
	for _, key := range []string{"plan", "required", "unchanged", "total_issues", "affected_issues", "project_ids", "status_mapping"} {
		if v, ok := raw[key]; ok {
			details[key] = v
		}
	}
	if len(details) == 0 {
		details = nil
	}
	return &OperationError{
		Code: redact(code, token), Status: status, Details: details,
		Message: fmt.Sprintf("Multica operation failed (HTTP %d). %s", status, truncate(redact(message, token), 1000)),
	}
}

func redact(s, token string) string {
	if token == "" {
		return s
	}
	return strings.ReplaceAll(s, token, "[redacted]")
}
