package contextmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

type toolFixture struct {
	store        *store.Store
	scopeID      int64
	tools        map[string]Tool
	attachmentID string
}

func newToolFixture(t *testing.T) *toolFixture {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, filepath.Join(t.TempDir(), "c.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	scopeID, _ := s.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "w"})
	otherScope, _ := s.EnsureScope(ctx, store.Scope{APIOrigin: "o", UserID: "u", WorkspaceID: "other"})
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	for _, c := range []store.NewConversation{
		{ID: "conv-1", ScopeID: scopeID, Provider: "claude", Title: "排查崩溃", CreatedAt: now},
		{ID: "conv-2", ScopeID: scopeID, Provider: "codex", Title: "Release notes", CreatedAt: now},
		{ID: "conv-x", ScopeID: otherScope, Provider: "claude", Title: "排查 other workspace", CreatedAt: now},
	} {
		if _, err := s.CreateConversation(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	w := s.NewWriter(store.WriterOptions{})
	defer w.Close()
	var messages []store.NewMessage
	for i := range 5 {
		messages = append(messages, store.NewMessage{ID: fmt.Sprintf("m%d", i), TurnID: "turn-1", Role: "user", Content: fmt.Sprintf("message %d", i), CreatedAt: now.Add(time.Duration(i) * time.Second)})
	}
	messages[4].Content = strings.Repeat("长", messageExcerpt+10)
	attachment, err := s.WriteAttachmentFile(scopeID, "conv-1", "image/png", []byte("\x89PNG\r\n\x1a\n"), now)
	if err != nil {
		t.Fatal(err)
	}
	ev := func(item, kind string) store.NewEvent {
		return store.NewEvent{TurnID: "turn-1", ItemID: item, Type: "item.completed", Final: true, Payload: json.RawMessage(`{"kind":"` + kind + `","status":"completed"}`), CreatedAt: now}
	}
	_, err = w.Submit(ctx, store.Batch{ConversationID: "conv-1", StartTurn: &store.NewTurn{ID: "turn-1", StartedAt: now}, Messages: messages,
		Attachments: []store.NewAttachment{attachment},
		Events:      []store.NewEvent{ev("r1", "reasoning"), ev("c1", "command"), ev("a1", "assistant_text")}})
	if err != nil {
		t.Fatal(err)
	}
	f := &toolFixture{store: s, scopeID: scopeID, tools: map[string]Tool{}, attachmentID: attachment.ID}
	for _, tool := range ContextTools(s, nil, scopeID, map[string]any{"workspace_id": "w", "conversation_id": "conv-1"}) {
		f.tools[tool.Name] = tool
	}
	return f
}

func (f *toolFixture) call(t *testing.T, name, args string) (map[string]any, *Image, error) {
	t.Helper()
	result, err := f.tools[name].Call(context.Background(), json.RawMessage(args))
	if err != nil {
		return nil, nil, err
	}
	data, _ := json.Marshal(result.Value)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	return out, result.Image, nil
}

func TestContextToolsSearchOnlyThisScope(t *testing.T) {
	t.Parallel()

	f := newToolFixture(t)
	out, _, err := f.call(t, "search_context", `{"kind":"conversation","query":"排查"}`)
	if err != nil {
		t.Fatal(err)
	}
	results := out["results"].([]any)
	if len(results) != 1 || results[0].(map[string]any)["id"] != "conv-1" {
		t.Fatalf("results = %v", results)
	}
	out, _, _ = f.call(t, "search_context", `{"kind":"conversation","query":"","limit":1}`)
	if len(out["results"].([]any)) != 1 || out["limited"] != true {
		t.Fatalf("limited search = %v", out)
	}
	if _, _, err := f.call(t, "read_context", `{"kind":"conversation","id":"conv-x"}`); err == nil {
		t.Fatal("read another workspace's conversation")
	}
}

func TestReadContextPagesBackwardsWithCursors(t *testing.T) {
	t.Parallel()

	f := newToolFixture(t)
	out, _, err := f.call(t, "read_context", `{"kind":"conversation","id":"conv-1","limit":2}`)
	if err != nil {
		t.Fatal(err)
	}
	page := out["messages"].([]any)
	last := page[1].(map[string]any)
	if page[0].(map[string]any)["id"] != "m3" || last["id"] != "m4" || last["content_truncated"] != true || out["has_more"] != true {
		t.Fatalf("first page = %v", out)
	}
	cursor := out["next_cursor"].(string)
	out, _, err = f.call(t, "read_context", `{"kind":"conversation","id":"conv-1","limit":2,"cursor":"`+cursor+`"}`)
	if err != nil || out["messages"].([]any)[0].(map[string]any)["id"] != "m1" {
		t.Fatalf("second page = %v, %v", out, err)
	}
	if _, _, err := f.call(t, "read_context", `{"kind":"conversation","id":"conv-2","cursor":"`+cursor+`"}`); err == nil {
		t.Fatal("cursor accepted for another conversation")
	}
}

func TestReadMessageAndExecution(t *testing.T) {
	t.Parallel()

	f := newToolFixture(t)
	out, _, err := f.call(t, "read_message", `{"conversation_id":"conv-1","message_id":"m4","offset":8000,"length":100}`)
	if err != nil || out["content"] != strings.Repeat("长", 10) || out["next_offset"] != nil || out["total_length"].(float64) != messageExcerpt+10 {
		t.Fatalf("read_message = %v, %v", out, err)
	}
	out, _, err = f.call(t, "read_execution", `{"conversation_id":"conv-1","turn_id":"turn-1"}`)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, e := range out["events"].([]any) {
		kinds = append(kinds, e.(map[string]any)["state"].(map[string]any)["kind"].(string))
	}
	if fmt.Sprint(kinds) != "[command assistant_text]" {
		t.Fatalf("execution kinds = %v (reasoning must be hidden)", kinds)
	}
}

func TestReadAttachmentReturnsSmallImagesInline(t *testing.T) {
	t.Parallel()

	f := newToolFixture(t)
	out, img, err := f.call(t, "read_attachment", `{"id":"`+f.attachmentID+`"}`)
	if err != nil || img == nil || img.MimeType != "image/png" || out["mimeType"] != "image/png" {
		t.Fatalf("read_attachment = %v %+v %v", out, img, err)
	}
	if _, _, err := f.call(t, "read_attachment", `{"id":"missing"}`); err == nil {
		t.Fatal("missing attachment found")
	}
}

func TestCloudSourcesNeedACloudReader(t *testing.T) {
	t.Parallel()

	f := newToolFixture(t)
	if _, _, err := f.call(t, "search_context", `{"kind":"task","query":"x"}`); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("task search without cloud = %v", err)
	}
	out, _, _ := f.call(t, "current_context", `{}`)
	if out["conversation_id"] != "conv-1" {
		t.Fatalf("current_context = %v", out)
	}
}
