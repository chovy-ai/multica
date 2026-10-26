package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const contextIssueID = "00000000-0000-0000-0000-000000000124"

func contextTestCommand() (*cobra.Command, *bytes.Buffer) {
	cmd := &cobra.Command{}
	cmd.Flags().String("output", "json", "")
	cmd.Flags().Int("recent", 20, "")
	cmd.Flags().String("before", "", "")
	cmd.Flags().String("before-id", "", "")
	out := &bytes.Buffer{}
	cmd.SetOut(out)
	return cmd, out
}

func contextTestEnv(t *testing.T, serverURL string) {
	t.Helper()
	for _, key := range []string{"MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_DAEMON_PORT", "MULTICA_TASK_CONFIG_ROOT"} {
		t.Setenv(key, "")
	}
	t.Setenv("MULTICA_TOKEN", "test-token")
	t.Setenv("MULTICA_SERVER_URL", serverURL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
}

func TestIssueContextIncludesUnfoldedThreadsAndExplicitPagination(t *testing.T) {
	description := strings.Repeat("full task description ", 500)
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("X-Workspace-ID") != "ws-1" {
			t.Errorf("unexpected query scope: method=%s workspace=%s", r.Method, r.Header.Get("X-Workspace-ID"))
		}
		if strings.HasSuffix(r.URL.Path, "/comments") {
			if r.URL.Query().Get("recent") != "20" || r.URL.Query().Has("fold") {
				t.Errorf("comments must be paged without folding: %v", r.URL.Query())
			}
			w.Header().Set("X-Multica-Next-Before", "2026-10-20T00:00:00Z")
			w.Header().Set("X-Multica-Next-Before-Id", "thread-older")
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"id": "comment", "content": "Complete discussion body", "attachments": []any{map[string]any{"id": "image"}, map[string]any{"id": "log"}}}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": contextIssueID, "workspace_id": "ws-1", "identifier": "TES-124", "description": description, "status": "in_progress", "priority": "high", "assignee_id": "member", "labels": []any{"bug"}, "project_id": "project", "metadata": map[string]any{"source": "test"}, "attachments": []any{map[string]any{"id": "image", "filename": "screenshot.png"}}})
	}))
	defer srv.Close()
	contextTestEnv(t, srv.URL)
	cmd, out := contextTestCommand()
	if err := runIssueContext(cmd, []string{contextIssueID}); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Issue        map[string]any   `json:"issue"`
		Comments     []map[string]any `json:"comments"`
		Attachments  []map[string]any `json:"attachments"`
		CommentsPage struct {
			HasMore    bool   `json:"has_more"`
			NextBefore string `json:"next_before"`
			NextID     string `json:"next_before_id"`
		} `json:"comments_page"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Issue["description"] != description || result.Issue["assignee_id"] != "member" || result.Comments[0]["content"] != "Complete discussion body" {
		t.Fatal("issue or discussion context was lost")
	}
	if len(result.Attachments) != 2 || !result.CommentsPage.HasMore || result.CommentsPage.NextID != "thread-older" {
		t.Fatalf("attachment directory or pagination missing: %s", out.String())
	}
	if len(paths) != 2 {
		t.Fatalf("expected two read requests, got %v", paths)
	}
}

func TestIssueContextContinuesWithCompositeCursor(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/comments") {
			if r.URL.Query().Get("before") != "2026-10-20T00:00:00Z" || r.URL.Query().Get("before_id") != "thread-older" {
				t.Errorf("lost composite cursor: %v", r.URL.Query())
			}
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`{"workspace_id":"ws-1"}`))
	}))
	defer srv.Close()
	contextTestEnv(t, srv.URL)
	cmd, out := contextTestCommand()
	_ = cmd.Flags().Set("before", "2026-10-20T00:00:00Z")
	_ = cmd.Flags().Set("before-id", "thread-older")
	if err := runIssueContext(cmd, []string{contextIssueID}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"has_more": false`) || !strings.Contains(out.String(), `"attachments": []`) {
		t.Fatalf("unexpected empty page: %s", out.String())
	}
}

func TestIssueContextDoesNotReturnPartialSuccessOnAccessOrReadErrors(t *testing.T) {
	for _, failure := range []string{"forbidden", "workspace", "comments", "cursor"} {
		t.Run(failure, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if failure == "forbidden" || (failure == "comments" && strings.HasSuffix(r.URL.Path, "/comments")) {
					http.Error(w, "forbidden", http.StatusForbidden)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/comments") {
					w.Header().Set("X-Multica-Next-Before", "incomplete")
					_, _ = w.Write([]byte(`[]`))
					return
				}
				workspace := "ws-1"
				if failure == "workspace" {
					workspace = "other"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": workspace})
			}))
			defer srv.Close()
			contextTestEnv(t, srv.URL)
			cmd, out := contextTestCommand()
			if err := runIssueContext(cmd, []string{contextIssueID}); err == nil || out.Len() != 0 {
				t.Fatalf("must return an error without partial JSON: %v %s", err, out.String())
			}
		})
	}
}

func TestIssueContextReportsServerTruncation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/comments") {
			w.Header().Set("X-Comments-Truncated", "true")
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_, _ = w.Write([]byte(`{"workspace_id":"ws-1"}`))
	}))
	defer srv.Close()
	contextTestEnv(t, srv.URL)
	cmd, out := contextTestCommand()
	if err := runIssueContext(cmd, []string{contextIssueID}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"truncated": true`) {
		t.Fatalf("server data loss must be explicit: %s", out.String())
	}
}
