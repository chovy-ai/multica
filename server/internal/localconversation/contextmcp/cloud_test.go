package contextmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHelperCLI is a fake multica CLI. It runs only when re-executed by
// cloudFixture, never as a normal test.
func TestHelperCLI(t *testing.T) {
	if os.Getenv("CONTEXT_CLI_HELPER") != "1" {
		return
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "MULTICA_LEAK") {
			fmt.Print(`{"leaked":true}`)
			os.Exit(0)
		}
	}
	joined := strings.Join(args, " ")
	switch {
	case strings.Contains(joined, "issue context"):
		fmt.Printf(`{"issue":{"id":"i1","workspace_id":"w"},"comments":[],"comments_page":{"has_more":true,"next_before":"t1","next_before_id":"c1"},"args":%q}`, joined)
	case strings.Contains(joined, "attachment download"):
		out := args[len(args)-1]
		path := filepath.Join(out, "report.txt")
		_ = os.WriteFile(path, []byte("hello"), 0o600)
		fmt.Printf(`{"path":%q}`, path)
	default:
		os.Exit(1)
	}
	os.Exit(0)
}

func cloudFixture(t *testing.T, token string) *CloudClient {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("X-Workspace-ID") != "w" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.URL.Path == "/api/issues/search":
			if r.URL.Query().Get("include_closed") != "true" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"issues":[{"id":"i1","identifier":"MUL-1","title":"crash","status":"todo","workspace_id":"w","secret":"x"}]}`)
		case r.URL.Path == "/api/agents":
			fmt.Fprint(w, `[{"id":"a1","name":"Reviewer","workspace_id":"w"},{"id":"a2","name":"Claude Code","workspace_id":"w"},{"id":"a3","name":"Old","workspace_id":"w","archived_at":"2026-01-01"}]`)
		case r.URL.Path == "/api/agents/a1":
			fmt.Fprint(w, `{"id":"a1","name":"Reviewer","instructions":"review","workspace_id":"w","token":"hidden"}`)
		case r.URL.Path == "/api/agents/foreign":
			fmt.Fprint(w, `{"id":"foreign","workspace_id":"other"}`)
		case r.URL.Path == "/api/chat/sessions":
			fmt.Fprint(w, `[{"id":"chat-1","title":"Plan","workspace_id":"w"},{"id":"chat-2","title":"Other","workspace_id":"w"}]`)
		case r.URL.Path == "/api/chat/sessions/chat-1":
			fmt.Fprint(w, `{"id":"chat-1","title":"Plan","workspace_id":"w"}`)
		case r.URL.Path == "/api/chat/sessions/chat-1/messages/page":
			if r.URL.Query().Get("before_id") == "m1" {
				fmt.Fprint(w, `{"messages":[{"id":"m0"}],"has_more":false}`)
				return
			}
			fmt.Fprint(w, `{"messages":[{"id":"m1"}],"has_more":true,"next_cursor":{"created_at":"2026-10-29T00:00:00Z","id":"m1"}}`)
		case r.URL.Path == "/api/attachments/att-1":
			fmt.Fprint(w, `{"id":"att-1","workspace_id":"w","content_type":"text/plain","filename":"report.txt"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(api.Close)
	t.Setenv("MULTICA_LEAK_CHECK", "1")
	cli := filepath.Join(t.TempDir(), "multica")
	script := fmt.Sprintf("#!/bin/sh\nCONTEXT_CLI_HELPER=1 exec %q -test.run=^TestHelperCLI$ -- \"$@\"\n", os.Args[0])
	if err := os.WriteFile(cli, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return &CloudClient{APIURL: api.URL, WorkspaceID: "w", Token: func() string { return token }, CLIPath: cli, Dir: t.TempDir()}
}

func asMap(t *testing.T, v any) map[string]any {
	t.Helper()
	data, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out
}

func TestCloudSearchProjectsAndFiltersResults(t *testing.T) {
	c := cloudFixture(t, "tok")
	ctx := context.Background()
	tasks, err := c.Search(ctx, "task", "crash", 20)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(asMap(t, tasks)["results"]); got != "[map[id:i1 identifier:MUL-1 status:todo title:crash]]" {
		t.Fatalf("tasks = %s", got)
	}
	agents, _ := c.Search(ctx, "agent", "", 20)
	if got := asMap(t, agents)["results"].([]any); len(got) != 1 || got[0].(map[string]any)["id"] != "a1" {
		t.Fatalf("agents = %v (built-in and archived agents must be hidden)", got)
	}
	chats, _ := c.Search(ctx, "conversation", "chat-2", 20)
	if got := asMap(t, chats)["results"].([]any); len(got) != 1 {
		t.Fatalf("chats by id = %v", got)
	}
}

func TestCloudReadAgentsChatsAndTasks(t *testing.T) {
	c := cloudFixture(t, "tok")
	ctx := context.Background()
	agent, err := c.Read(ctx, "agent", "a1", 10, "")
	if err != nil || asMap(t, agent)["agent"].(map[string]any)["token"] != nil {
		t.Fatalf("agent = %v, %v", agent, err)
	}
	if _, err := c.Read(ctx, "agent", "foreign", 10, ""); err == nil {
		t.Fatal("agent of another workspace returned")
	}
	page, err := c.Read(ctx, "conversation", "chat-1", 10, "")
	if err != nil {
		t.Fatal(err)
	}
	cursor := asMap(t, page)["next_cursor"].(string)
	older, err := c.Read(ctx, "conversation", "chat-1", 10, cursor)
	if err != nil || asMap(t, older)["has_more"] != false {
		t.Fatalf("older page = %v, %v", older, err)
	}
	task, err := c.Read(ctx, "task", "i1", 5, "")
	if err != nil {
		t.Fatal(err)
	}
	m := asMap(t, task)
	if m["leaked"] == true {
		t.Fatal("the CLI inherited MULTICA_* variables")
	}
	if !strings.Contains(m["args"].(string), "issue context i1 --recent 5 --output json") || m["next_cursor"] == nil {
		t.Fatalf("task = %v", m)
	}
	if _, err := os.Stat(filepath.Join(c.Dir, "config.json")); err != nil {
		t.Fatalf("private CLI config missing: %v", err)
	}
}

func TestCloudAttachmentDownloadsIntoTheExecutionDirectory(t *testing.T) {
	c := cloudFixture(t, "tok")
	file, err := c.Attachment(context.Background(), "att-1")
	if err != nil {
		t.Fatal(err)
	}
	m := asMap(t, file)
	if m["name"] != "report.txt" || m["data"] != "aGVsbG8=" || !strings.HasPrefix(m["path"].(string), c.Dir) {
		t.Fatalf("attachment = %v", m)
	}
}

func TestCloudWithoutTokenIsUnavailable(t *testing.T) {
	c := cloudFixture(t, "")
	if _, err := c.Search(context.Background(), "task", "x", 5); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("search without token = %v", err)
	}
}
