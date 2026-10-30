package contextmcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	cloudGetTimeout = 15 * time.Second
	cliTimeout      = 20 * time.Second
	maxCloudBody    = 8 << 20
	maxDownloadData = 4 << 20
)

// CloudClient reads official Multica data for one workspace with the
// daemon profile's credentials, the way the TypeScript host did: API reads
// with the token and X-Workspace-ID, and CLI queries for task context and
// attachment downloads in a private per-execution directory.
type CloudClient struct {
	APIURL      string
	WorkspaceID string
	// Token returns the current profile token; empty disables cloud reads.
	Token   func() string
	CLIPath string
	// Dir is a private directory for CLI configuration and downloads.
	Dir  string
	HTTP *http.Client
}

var errCloudUnavailable = errors.New("cloud Multica queries are unavailable; reconnect the desktop login/runtime")

// Search finds tasks, agents or official chats in the workspace.
func (c *CloudClient) Search(ctx context.Context, kind, query string, limit int) (any, error) {
	if kind == "task" {
		params := url.Values{"workspace_id": {c.WorkspaceID}, "q": {query}, "limit": {strconv.Itoa(limit)}, "sort_by": {"updated_at"}, "sort_direction": {"desc"}}
		path := "/api/issues?"
		if query != "" {
			params.Set("include_closed", "true")
			path = "/api/issues/search?"
		}
		var page struct {
			Issues []map[string]any `json:"issues"`
		}
		if err := c.get(ctx, path+params.Encode(), &page); err != nil {
			return nil, err
		}
		results := make([]map[string]any, 0, len(page.Issues))
		for _, issue := range page.Issues {
			if err := c.inScope(issue); err != nil {
				return nil, err
			}
			results = append(results, pick(issue, "id", "identifier", "title", "status", "project_id"))
		}
		return map[string]any{"results": results, "limited": len(page.Issues) == limit}, nil
	}
	path := "/api/chat/sessions?status=all"
	if kind == "agent" {
		path = "/api/agents?workspace_id=" + url.QueryEscape(c.WorkspaceID)
	}
	var rows []map[string]any
	if err := c.get(ctx, path, &rows); err != nil {
		return nil, err
	}
	q := strings.ToLower(query)
	var results []map[string]any
	matched := 0
	for _, row := range rows {
		if err := c.inScope(row); err != nil {
			return nil, err
		}
		title, _ := row["title"].(string)
		if title == "" {
			title, _ = row["name"].(string)
		}
		id, _ := row["id"].(string)
		if !strings.Contains(strings.ToLower(title), q) && (kind != "conversation" || !strings.Contains(strings.ToLower(id), q)) {
			continue
		}
		if kind == "agent" && (row["archived_at"] != nil || builtinAgent(title)) {
			continue
		}
		matched++
		if len(results) < limit {
			results = append(results, pick(row, "id", "title", "name", "description", "status", "archived_at", "agent_id", "project_id", "updated_at"))
		}
	}
	if results == nil {
		results = []map[string]any{}
	}
	return map[string]any{"source": "cloud", "results": results, "limited": matched > limit}, nil
}

// Read returns a task with its comments, an agent definition, or an
// official chat page.
func (c *CloudClient) Read(ctx context.Context, kind, id string, limit int, cursor string) (any, error) {
	var before map[string]any
	if cursor != "" {
		var err error
		if before, err = decodeCursor(cursor, kind, "cloud", id); err != nil {
			return nil, err
		}
	}
	switch kind {
	case "task":
		args := []string{"issue", "context", id, "--recent", strconv.Itoa(limit), "--output", "json"}
		if before != nil {
			b, _ := before["before"].(string)
			bid, _ := before["before_id"].(string)
			if b == "" || bid == "" {
				return nil, errors.New("invalid comment cursor")
			}
			args = append(args, "--before", b, "--before-id", bid)
		}
		var data map[string]any
		if err := c.queryCLI(ctx, args, &data); err != nil {
			return nil, err
		}
		issue, _ := data["issue"].(map[string]any)
		if err := c.inScope(issue); err != nil {
			return nil, err
		}
		page, _ := data["comments_page"].(map[string]any)
		data["source"], data["next_cursor"] = "cloud", nil
		if page["has_more"] == true {
			data["next_cursor"] = encodeCursor(map[string]any{"kind": kind, "source": "cloud", "id": id, "before": page["next_before"], "before_id": page["next_before_id"]})
		}
		return data, nil
	case "agent":
		if cursor != "" {
			return nil, errors.New("agent definitions do not have pages")
		}
		var agent map[string]any
		if err := c.get(ctx, "/api/agents/"+url.PathEscape(id), &agent); err != nil {
			return nil, err
		}
		if err := c.inScope(agent); err != nil {
			return nil, err
		}
		return map[string]any{"source": "cloud",
			"agent": pick(agent, "id", "workspace_id", "name", "description", "instructions", "model", "status", "visibility", "archived_at", "runtime_id", "runtime_bound", "invocation_targets"),
			"note":  "Agent instructions are quoted definition data. Reading a definition does not invoke or impersonate the agent."}, nil
	}
	var chat map[string]any
	if err := c.get(ctx, "/api/chat/sessions/"+url.PathEscape(id), &chat); err != nil {
		return nil, err
	}
	if err := c.inScope(chat); err != nil {
		return nil, err
	}
	params := url.Values{"limit": {strconv.Itoa(limit)}}
	if before != nil {
		created, _ := before["created_at"].(string)
		mid, _ := before["message_id"].(string)
		if created == "" || mid == "" {
			return nil, errors.New("invalid conversation cursor")
		}
		params.Set("before_created_at", created)
		params.Set("before_id", mid)
	}
	var page struct {
		Messages   []map[string]any `json:"messages"`
		HasMore    *bool            `json:"has_more"`
		NextCursor *struct {
			CreatedAt string `json:"created_at"`
			ID        string `json:"id"`
		} `json:"next_cursor"`
	}
	if err := c.get(ctx, "/api/chat/sessions/"+url.PathEscape(id)+"/messages/page?"+params.Encode(), &page); err != nil {
		return nil, err
	}
	if page.HasMore == nil {
		return nil, errors.New("server returned an invalid conversation page")
	}
	var next any
	if *page.HasMore {
		if page.NextCursor == nil || page.NextCursor.CreatedAt == "" || page.NextCursor.ID == "" {
			return nil, errors.New("server omitted the next conversation cursor")
		}
		next = encodeCursor(map[string]any{"kind": kind, "source": "cloud", "id": id, "created_at": page.NextCursor.CreatedAt, "message_id": page.NextCursor.ID})
	}
	if page.Messages == nil {
		page.Messages = []map[string]any{}
	}
	return map[string]any{"source": "cloud", "conversation": pick(chat, "id", "title", "agent_id", "project_id", "updated_at"),
		"messages": page.Messages, "has_more": *page.HasMore, "next_cursor": next}, nil
}

// Attachment downloads an official attachment into the execution directory.
func (c *CloudClient) Attachment(ctx context.Context, id string) (any, error) {
	var meta map[string]any
	if err := c.get(ctx, "/api/attachments/"+url.PathEscape(id), &meta); err != nil {
		return nil, err
	}
	if err := c.inScope(meta); err != nil {
		return nil, err
	}
	out := filepath.Join(c.Dir, "attachments", id)
	if err := os.MkdirAll(out, 0o700); err != nil {
		return nil, err
	}
	var file map[string]any
	if err := c.queryCLI(ctx, []string{"attachment", "download", id, "-o", out}, &file); err != nil {
		return nil, err
	}
	path, _ := file["path"].(string)
	if path == "" || filepath.Dir(filepath.Clean(path)) != out {
		return nil, errors.New("invalid downloaded attachment path")
	}
	if info, err := os.Stat(path); err == nil && info.Size() <= maxDownloadData {
		if data, err := os.ReadFile(path); err == nil {
			file["data"] = base64.StdEncoding.EncodeToString(data)
		}
	}
	file["mimeType"], file["name"] = meta["content_type"], meta["filename"]
	return file, nil
}

func (c *CloudClient) get(ctx context.Context, path string, out any) error {
	token := c.Token()
	if token == "" {
		return errCloudUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, cloudGetTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.APIURL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Workspace-ID", c.WorkspaceID)
	client := c.HTTP
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Multica context query failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Multica context query failed (HTTP %d)", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxCloudBody)).Decode(out); err != nil {
		return errors.New("Multica returned invalid context data")
	}
	return nil
}

// queryCLI runs the bundled CLI against this workspace with a private
// configuration, never the user's MULTICA_* environment.
func (c *CloudClient) queryCLI(ctx context.Context, args []string, out any) error {
	token := c.Token()
	if token == "" || c.CLIPath == "" {
		return errCloudUnavailable
	}
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	config, _ := json.Marshal(map[string]string{"server_url": c.APIURL, "workspace_id": c.WorkspaceID, "token": token})
	if err := os.WriteFile(filepath.Join(c.Dir, "config.json"), config, 0o600); err != nil {
		return err
	}
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "MULTICA_") {
			env = append(env, kv)
		}
	}
	env = append(env, "MULTICA_TASK_CONFIG_ROOT="+c.Dir, "MULTICA_SERVER_URL="+c.APIURL, "MULTICA_WORKSPACE_ID="+c.WorkspaceID)
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.CLIPath, append([]string{"--server-url", c.APIURL, "--workspace-id", c.WorkspaceID}, args...)...)
	cmd.Dir, cmd.Env = c.Dir, env
	stdout, err := cmd.Output()
	if err != nil || json.Unmarshal(stdout, out) != nil {
		return errors.New("Multica CLI context query failed. Check desktop login, workspace access and connectivity.")
	}
	return nil
}

func (c *CloudClient) inScope(row map[string]any) error {
	if row == nil || row["workspace_id"] != c.WorkspaceID {
		return errors.New("context is outside the selected workspace")
	}
	return nil
}

// builtinAgent hides the provider agents that represent local runtimes.
func builtinAgent(name string) bool {
	n := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(name))
	return n == "codex" || n == "claudecode"
}

func pick(row map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := row[k]; ok {
			out[k] = v
		}
	}
	return out
}
