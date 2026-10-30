package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/catalog"
)

func titleFixture(t *testing.T, script string) *serviceFixture {
	t.Helper()
	cli := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\ncat > /dev/null\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	find := func(context.Context, string) (string, error) { return cli, nil }
	f := newServiceFixtureWith(t, filepath.Join(t.TempDir(), "c.sqlite"), Options{Catalog: catalog.New(find, t.TempDir(), t.TempDir())})
	if _, err := f.svc.Create(context.Background(), CreateCommand{ScopeID: f.scopeID, ID: "conv-1", Provider: "claude"}); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestTitlesFollowTheFirstMessageThenTheModel(t *testing.T) {
	t.Parallel()

	f := titleFixture(t, `echo "登录崩溃排查"`)
	ctx := context.Background()
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "请帮我修复登录页的崩溃。顺便看日志"}); err != nil {
		t.Fatal(err)
	}
	conv, _ := f.svc.Store().Conversation(ctx, "conv-1")
	if conv.Title != "修复登录页的崩溃。" {
		t.Fatalf("first-message title = %q", conv.Title)
	}
	f.adapters[0].emit(t, turnDone)
	var idleAt string
	eventually(t, "the turn to end", func() bool {
		c, _ := f.svc.Store().Conversation(ctx, "conv-1")
		idleAt = c.UpdatedAt
		return c.Status == "idle"
	})
	eventually(t, "the generated title", func() bool {
		c, _ := f.svc.Store().Conversation(ctx, "conv-1")
		return c.Title == "登录崩溃排查" && c.TitleGeneration == "complete"
	})
	if c, _ := f.svc.Store().Conversation(ctx, "conv-1"); c.UpdatedAt != idleAt {
		t.Fatalf("the title moved the conversation in the list: %s -> %s", idleAt, c.UpdatedAt)
	}
}

func TestRenamingCancelsTitleGeneration(t *testing.T) {
	t.Parallel()

	f := titleFixture(t, `sleep 5; echo "too late"`)
	ctx := context.Background()
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	f.adapters[0].emit(t, turnDone)
	eventually(t, "title generation to start", func() bool {
		c, _ := f.svc.Store().Conversation(ctx, "conv-1")
		return c.TitleGeneration == "pending"
	})
	name := "我的会话"
	if _, err := f.svc.UpdateMetadata(ctx, f.scopeID, "conv-1", MetadataUpdate{Title: &name}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if c, _ := f.svc.Store().Conversation(ctx, "conv-1"); c.Title != name || c.TitleMode != "manual" {
		t.Fatalf("after rename = %q/%q", c.Title, c.TitleMode)
	}
}
