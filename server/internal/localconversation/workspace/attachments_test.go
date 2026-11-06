package workspace

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestAttachmentWritesRejectForeignAndUnconfirmedMaterials(t *testing.T) {
	for _, name := range []string{"create_task", "update_task", "comment_task", "invoke_agent"} {
		t.Run(name, func(t *testing.T) {
			tools, api := newTools(t, map[string]any{
				"GET /api/attachments/foreign": row{"id": "foreign", "workspace_id": "ws-other", "markdown_url": "https://example/file"},
				"GET /api/issues/i-1":          row{"id": "i-1", "workspace_id": "ws-1"},
				"GET /api/agents/a-1":          row{"id": "a-1", "workspace_id": "ws-1"},
			}, nil)
			fields := `"title":"Bug"`
			switch name {
			case "update_task":
				fields = `"id":"i-1"`
			case "comment_task":
				fields = `"id":"i-1","content":"Details"`
			case "invoke_agent":
				fields = `"agent_id":"a-1","content":"Register"`
			}
			for i, extra := range []string{`"attachment_ids":["foreign"]`, `"local_attachment_ids":["local-1"]`} {
				if _, err := call(t, tools, name, fmt.Sprintf(`{%s,%s,"request_id":"r%d"}`, fields, extra, i)); err == nil {
					t.Fatal("invalid attachment was accepted")
				}
			}
			for _, key := range api.calls {
				if !strings.HasPrefix(key, "GET ") {
					t.Fatalf("invalid attachments caused a write: %s", key)
				}
			}
		})
	}
}

func TestTaskReadbackFailureDoesNotRepeatTheWrite(t *testing.T) {
	tools, api := newTools(t, map[string]any{
		"GET /api/attachments/att-1":      row{"id": "att-1", "workspace_id": "ws-1", "markdown_url": "https://example/file"},
		"POST /api/issues":                row{"id": "i-1", "workspace_id": "ws-1"},
		"GET /api/issues/i-1/attachments": []any{},
	}, nil)
	for range 2 {
		if _, err := call(t, tools, "create_task", `{"title":"Bug","attachment_ids":["att-1"],"request_id":"r1"}`); err == nil || !strings.Contains(err.Error(), "Task i-1 was written") {
			t.Fatalf("missing binding = %v", err)
		}
	}
	if api.count("POST /api/issues") != 1 {
		t.Fatal("unconfirmed binding caused a repeated task creation")
	}
}

func TestLocalAttachmentUploadFailurePreventsTextOnlySubmission(t *testing.T) {
	writes, uploads := 0, 0
	for _, tool := range Tools(Options{WorkspaceID: "ws-1", Request: attachmentRequester{&writes}, UploadAttachments: func(context.Context, []string) ([]string, error) {
		uploads++
		return nil, fmt.Errorf("upload failed")
	}}) {
		if tool.Name == "create_task" {
			for range 2 {
				_, err := tool.Call(context.Background(), []byte(`{"title":"Bug","local_attachment_ids":["local-1"],"request_id":"r1"}`))
				if err == nil || !strings.Contains(err.Error(), "upload failed") {
					t.Fatalf("upload = %v", err)
				}
			}
		}
	}
	if writes != 0 || uploads != 1 {
		t.Fatalf("writes = %d, uploads = %d", writes, uploads)
	}
}

type attachmentRequester struct{ writes *int }

func (r attachmentRequester) Request(context.Context, string, string, any) (any, error) {
	*r.writes++
	return nil, fmt.Errorf("unexpected API write")
}

func TestTaskAndAgentToolsCarryCloudAttachments(t *testing.T) {
	for _, name := range []string{"create_task", "update_task", "comment_task", "invoke_agent"} {
		t.Run(name, func(t *testing.T) {
			tools, api := newTools(t, map[string]any{
				"GET /api/attachments/att-1":              row{"id": "att-1", "workspace_id": "ws-1", "filename": "recording.mp4", "content_type": "video/mp4", "markdown_url": "https://api.example/api/attachments/att-1/download"},
				"GET /api/issues/i-1":                     row{"id": "i-1", "workspace_id": "ws-1", "description": "Original"},
				"GET /api/issues/i-1/attachments":         []any{row{"id": "att-1"}},
				"POST /api/issues":                        row{"id": "i-1", "workspace_id": "ws-1"},
				"PUT /api/issues/i-1":                     row{"id": "i-1", "workspace_id": "ws-1"},
				"POST /api/issues/i-1/comments":           row{"id": "comment-1"},
				"GET /api/agents/a-1":                     row{"id": "a-1", "workspace_id": "ws-1"},
				"POST /api/chat/sessions":                 row{"id": "chat-1", "workspace_id": "ws-1"},
				"POST /api/chat/sessions/chat-1/messages": row{"task_id": "run-1"},
			}, nil)
			fields, path, textField := `"title":"Bug","description":"Details"`, "POST /api/issues", "description"
			switch name {
			case "update_task":
				fields, path = `"id":"i-1"`, "PUT /api/issues/i-1"
			case "comment_task":
				fields, path, textField = `"id":"i-1","content":"Details"`, "POST /api/issues/i-1/comments", "content"
			case "invoke_agent":
				fields, path, textField = `"agent_id":"a-1","content":"Register this bug"`, "POST /api/chat/sessions/chat-1/messages", "content"
			}
			args := fmt.Sprintf(`{%s,"attachment_ids":["att-1","att-1"],"request_id":"submit"}`, fields)
			if _, err := call(t, tools, name, args); err != nil {
				t.Fatal(err)
			}
			body := api.bodies[path]
			if fmt.Sprint(body["attachment_ids"]) != "[att-1]" || !strings.Contains(fmt.Sprint(body[textField]), "https://api.example/api/attachments/att-1/download") {
				t.Fatalf("attachment missing from %s: %v", path, body)
			}
			if name == "update_task" && !strings.HasPrefix(body["description"].(string), "Original") {
				t.Fatalf("existing description lost: %v", body)
			}
			if _, err := call(t, tools, name, args); err != nil || api.count(path) != 1 {
				t.Fatalf("retry = %v; writes = %d", err, api.count(path))
			}
		})
	}
}
