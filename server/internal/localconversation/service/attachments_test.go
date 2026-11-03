package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/contextmcp"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

type attachmentCloud struct {
	fakeCloud
	muFiles    sync.Mutex
	files      []string
	writeBody  map[string]any
	writes     int
	uploadErr  error
	failUpload int
	writeErr   error
	missing    bool
}

func (c *attachmentCloud) Upload(_ context.Context, path, name, mediaType string) (string, string, error) {
	c.muFiles.Lock()
	defer c.muFiles.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	c.files = append(c.files, name+":"+mediaType+":"+string(data))
	err = c.uploadErr
	if c.failUpload > 0 && len(c.files) != c.failUpload {
		err = nil
	}
	return fmt.Sprintf("att-%d", len(c.files)), "https://files.example/upload", err
}

func (c *attachmentCloud) Request(_ context.Context, method, path string, body any) (any, error) {
	c.muFiles.Lock()
	defer c.muFiles.Unlock()
	switch {
	case method == "GET" && strings.HasPrefix(path, "/api/attachments/"):
		id := strings.TrimPrefix(path, "/api/attachments/")
		return map[string]any{"id": id, "workspace_id": "w", "filename": id, "content_type": "video/mp4", "markdown_url": "https://api.example/api/attachments/" + id + "/download"}, nil
	case method == "GET" && path == "/api/issues/i-1/attachments":
		var list []any
		if !c.missing && c.writeBody != nil {
			for _, id := range c.writeBody["attachment_ids"].([]string) {
				list = append(list, map[string]any{"id": id})
			}
		}
		return list, nil
	case method == "POST" && path == "/api/issues":
		c.writes++
		c.writeBody = body.(map[string]any)
		return map[string]any{"id": "i-1", "workspace_id": "w", "identifier": "TEST-1"}, c.writeErr
	}
	return nil, fmt.Errorf("unexpected %s %s", method, path)
}

func TestAttachmentSubmissionThroughMCPAcrossTurns(t *testing.T) {
	for _, media := range []struct{ name, typ, data string }{
		{"screen.png", "image/png", "synthetic png"},
		{"recording.mp4", "video/mp4", "synthetic mp4"},
	} {
		t.Run(media.name, func(t *testing.T) {
			ctx := context.Background()
			cloud := &attachmentCloud{}
			f := newServiceFixtureWith(t, filepath.Join(t.TempDir(), "c.sqlite"), Options{Cloud: func(store.Scope, string) contextmcp.Cloud { return cloud }})
			f.create(t, "conv-1", "claude")
			conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
			a, err := f.svc.Store().StoreUpload(ctx, f.scopeID, "local-1", media.name, media.typ, strings.NewReader(media.data), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			args := fmt.Sprintf(`{"title":"Bug","local_attachment_ids":[%q,%q],"request_id":"register"}`, a.ID, a.ID)
			for range 2 {
				bound, release, err := f.svc.contextBinder(conv)(ctx, "", func() map[string]any { return map[string]any{"conversation_id": conv.ID} })
				if err != nil {
					t.Fatal(err)
				}
				body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_task","arguments":` + args + `}}`
				req, _ := http.NewRequest("POST", bound.URL, strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+bound.Token)
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				var response struct {
					Result struct {
						IsError bool                    `json:"isError"`
						Content []struct{ Text string } `json:"content"`
					} `json:"result"`
				}
				err = json.NewDecoder(res.Body).Decode(&response)
				res.Body.Close()
				release()
				if err != nil || response.Result.IsError || len(response.Result.Content) == 0 || !strings.Contains(response.Result.Content[0].Text, "TEST-1") {
					t.Fatalf("MCP submission = %+v, %v", response, err)
				}
			}
			if len(cloud.files) != 1 || cloud.files[0] != media.name+":"+media.typ+":"+media.data || cloud.writes != 1 {
				t.Fatalf("files = %v, writes = %d", cloud.files, cloud.writes)
			}
			if _, leaked := cloud.writeBody["local_attachment_ids"]; leaked || fmt.Sprint(cloud.writeBody["attachment_ids"]) != "[att-1]" {
				t.Fatalf("cloud request = %v", cloud.writeBody)
			}
			// A later operation reuses the same cloud file after the duplicate choice.
			ids, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{a.ID})
			if err != nil || fmt.Sprint(ids) != "[att-1]" || len(cloud.files) != 1 {
				t.Fatalf("later upload = %v, %v", ids, err)
			}
		})
	}
}

func TestAttachmentUploadScopeAndUnknownOutcome(t *testing.T) {
	ctx := context.Background()
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	cloud := &attachmentCloud{uploadErr: errors.New("connection lost")}
	_, err := f.svc.Store().StoreUpload(ctx, f.scopeID, "local-1", "screen.png", "image/png", strings.NewReader("png"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.svc.Store().EnsureScope(ctx, store.Scope{APIOrigin: "https://api.multica.ai", UserID: "other", WorkspaceID: "w"})
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []store.Scope{{APIOrigin: "https://other.example", UserID: "u", WorkspaceID: "w"}, {APIOrigin: "https://api.multica.ai", UserID: "u", WorkspaceID: "other"}} {
		id, err := f.svc.Store().EnsureScope(ctx, scope)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.uploadAttachments(ctx, id, cloud, []string{"local-1"}); err == nil {
			t.Fatal("foreign scope attachment was uploaded")
		}
	}
	if _, err := f.svc.uploadAttachments(ctx, other, cloud, []string{"local-1"}); err == nil || len(cloud.files) != 0 {
		t.Fatalf("cross-account upload = %v, files %v", err, cloud.files)
	}
	if _, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{"local-1", "missing"}); err == nil || len(cloud.files) != 0 {
		t.Fatalf("invalid batch partially uploaded: %v, files %v", err, cloud.files)
	}
	for range 2 {
		if _, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{"local-1"}); err == nil || !strings.Contains(err.Error(), "not confirmed") {
			t.Fatalf("unknown upload = %v", err)
		}
	}
	if len(cloud.files) != 1 {
		t.Fatalf("unknown upload was repeated: %v", cloud.files)
	}
}

func TestPartialAttachmentUploadRetainsTheConfirmedFile(t *testing.T) {
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	cloud := &attachmentCloud{failUpload: 2, uploadErr: errors.New("connection lost")}
	for _, id := range []string{"first", "second"} {
		if _, err := f.svc.Store().StoreUpload(ctx, f.scopeID, id, id+".mp4", "video/mp4", strings.NewReader(id), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if _, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{"first", "second"}); err == nil {
			t.Fatal("partial upload reported success")
		}
	}
	if len(cloud.files) != 2 {
		t.Fatalf("a partial upload was repeated: %v", cloud.files)
	}
}

func TestRejectedAttachmentUploadCanBeRetriedAfterCorrection(t *testing.T) {
	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	cloud := &attachmentCloud{uploadErr: &contextmcp.OperationError{Status: 403, Message: "access denied"}}
	if _, err := f.svc.Store().StoreUpload(ctx, f.scopeID, "file-1", "recording.mp4", "video/mp4", strings.NewReader("mp4"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{"file-1"}); err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("rejected upload = %v", err)
	}
	cloud.uploadErr = nil
	if _, err := f.svc.uploadAttachments(ctx, f.scopeID, cloud, []string{"file-1"}); err != nil || len(cloud.files) != 2 {
		t.Fatalf("corrected upload = %v, files %v", err, cloud.files)
	}
}

func TestGUIAgentAttachmentReferencesReuseTheCloudUpload(t *testing.T) {
	f, cloud := remoteFixture(t)
	ctx := context.Background()
	cloud.reply()
	a, err := f.svc.Store().StoreUpload(ctx, f.scopeID, "local-video", "recording.mp4", "video/mp4", strings.NewReader("mp4"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, requestID := range []string{"r1", "r2"} {
		result, err := f.svc.SendToAgents(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: requestID, Text: "Register this bug", AttachmentIDs: []string{a.ID, a.ID}}, []RemoteAgent{{ID: "agent-1", Name: "Writer"}, {ID: "agent-2", Name: "Reviewer"}})
		if err != nil {
			t.Fatal(err)
		}
		eventually(t, "the remote turn to finish", func() bool {
			for _, id := range result.TurnIDs {
				turn, _ := f.svc.Store().Turn(ctx, "conv-1", id)
				if turn.Status != "completed" {
					return false
				}
			}
			return true
		})
	}
	cloud.mu.Lock()
	defer cloud.mu.Unlock()
	body := cloud.bodies["POST /api/chat/sessions/chat-1/messages"].(map[string]any)
	if cloud.uploads != 1 || fmt.Sprint(body["attachment_ids"]) != "[att-1]" || !strings.Contains(body["content"].(string), `"attachment_id":"att-1"`) || !strings.Contains(body["content"].(string), taskAttachmentInstructions) {
		t.Fatalf("uploads = %d, cloud message = %v", cloud.uploads, body)
	}
}

func TestAttachmentWriteOutcomesSurviveBindingsAndScope(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
			writes := 0
			tool := contextmcp.Tool{Name: "comment_task", Call: func(context.Context, json.RawMessage) (contextmcp.Result, error) {
				writes++
				if fail {
					return contextmcp.Result{}, errors.New("Write was not confirmed")
				}
				return contextmcp.Result{Value: map[string]any{"id": "comment-1"}}, nil
			}}
			for range 2 {
				bound := f.svc.attachmentWriteTool(f.scopeID, "conv-1", tool)
				_, err := bound.Call(context.Background(), json.RawMessage(`{"attachment_ids":["cloud-1"],"request_id":"same"}`))
				if (err != nil) != fail {
					t.Fatalf("write = %v", err)
				}
			}
			if writes != 1 {
				t.Fatalf("writes = %d", writes)
			}
			bound := f.svc.attachmentWriteTool(f.scopeID, "conv-1", tool)
			if _, err := bound.Call(context.Background(), json.RawMessage(`{"attachment_ids":["cloud-2"],"request_id":"same"}`)); err == nil {
				t.Fatal("changed input reused a receipt")
			}
		})
	}
}
