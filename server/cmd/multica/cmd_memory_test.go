package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func memoryCLI(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	u, _ := url.Parse(server.URL)
	t.Setenv("MULTICA_DAEMON_PORT", u.Port())
	t.Setenv("MULTICA_TOKEN", "task")
}
func TestMemoryCLIRequiresTask(t *testing.T) {
	t.Setenv("MULTICA_DAEMON_PORT", "")
	t.Setenv("MULTICA_TOKEN", "")
	cmd := newMemoryCommand()
	cmd.SetArgs([]string{"list"})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "only inside a Multica agent task") {
		t.Fatal(err)
	}
}
func TestMemoryCLICommands(t *testing.T) {
	for _, tc := range []struct {
		args                                []string
		method, path, response, want, stdin string
	}{
		{[]string{"list", "--all"}, "GET", "/memory/index?all=1", `{"text":"# Memory\n"}`, "# Memory", ""},
		{[]string{"search", "迁移"}, "GET", "/memory/search?q=%E8%BF%81%E7%A7%BB&limit=10", `{"hits":[{"path":"feedback/test.md","title":"Title","snippet":"Text"}]}`, "feedback/test.md — Title: Text", ""},
		{[]string{"search", "nothing"}, "GET", "/memory/search?q=nothing&limit=10", `{"hits":[]}`, "No matching memory.", ""},
		{[]string{"write", "feedback/test", "--title", "Title", "--description", "Description", "--update"}, "PUT", "/memory/entry", `{"entry":{"path":"feedback/test.md"},"warnings":["body_over_soft_limit"]}`, "Saved feedback/test.md", "Body"},
		{[]string{"read", "feedback/test.md"}, "GET", "/memory/entry?path=feedback%2Ftest.md", `{"entry":{"title":"Title","description":"Description","body":"Body","created_at":"2026-11-14T00:00:00Z","updated_at":"2026-11-14T00:00:00Z"}}`, "---\ntitle: Title", ""},
		{[]string{"delete", "feedback/test.md"}, "DELETE", "/memory/entry?path=feedback%2Ftest.md", `{"trash_path":"stamp/feedback/test.md"}`, "recoverable for 30 days", ""},
		{[]string{"list", "--output", "json"}, "GET", "/memory/index", `{"text":"index"}`, `{"text":"index"}`, ""},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			memoryCLI(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.method || r.URL.RequestURI() != tc.path || r.Header.Get("Authorization") != "Bearer task" {
					t.Errorf("bad request: %s %s", r.Method, r.URL.RequestURI())
				}
				fmt.Fprint(w, tc.response)
			})
			var out, stderr bytes.Buffer
			cmd := newMemoryCommand()
			cmd.SetOut(&out)
			cmd.SetErr(&stderr)
			cmd.SetIn(strings.NewReader(tc.stdin))
			cmd.SetArgs(tc.args)
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), tc.want) {
				t.Fatal(out.String())
			}
			if tc.method == "PUT" && !strings.Contains(stderr.String(), "warning: body is over 2KB") {
				t.Fatal(stderr.String())
			}
		})
	}
}
func TestMemoryCLIRejectsEmptyStdinAndLimits(t *testing.T) {
	for _, args := range [][]string{{"write", "feedback/test", "--title", "T", "--description", "D"}, {"search", "q", "--limit", "51"}} {
		cmd := newMemoryCommand()
		cmd.SetIn(strings.NewReader(""))
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Fatal("expected validation error")
		}
	}
}
func TestMemoryReceiptsComments(t *testing.T) {
	for _, tc := range []struct {
		response string
		status   int
		want     string
		warning  bool
	}{{`{"titles":["A","B"]}`, 200, "Reply\n\n已记住：A、B", false}, {`{"titles":[]}`, 200, "Reply\n", false}, {`{}`, 404, "Reply\n", true}} {
		t.Run(fmt.Sprint(tc.status, tc.response), func(t *testing.T) {
			memoryCLI(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/memory/receipts/claim" {
					t.Error(r.Method, r.URL.Path)
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.response)
			})
			var stderr bytes.Buffer
			if got := attachMemoryReceipt("Reply\n", &stderr); got != tc.want {
				t.Fatal(got)
			}
			if strings.Contains(stderr.String(), "warning:") != tc.warning {
				t.Fatal(stderr.String())
			}
		})
	}
	t.Setenv("MULTICA_DAEMON_PORT", "")
	var stderr bytes.Buffer
	if got := attachMemoryReceipt("Unchanged", &stderr); got != "Unchanged" || stderr.Len() != 0 {
		t.Fatal(got, stderr.String())
	}
}
