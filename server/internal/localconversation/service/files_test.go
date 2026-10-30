package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

func TestSendWithAttachmentsTellsTheProviderWhereTheyAre(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	f.create(t, "conv-1", "claude")
	a, err := f.svc.Upload(ctx, f.scopeID, "notes.md", "text/markdown", strings.NewReader("# notes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r1", Text: "read this", AttachmentIDs: []string{a.ID}}); err != nil {
		t.Fatal(err)
	}
	_, path, _ := f.svc.AttachmentFile(ctx, f.scopeID, a.ID)
	if data, _ := os.ReadFile(path); string(data) != "# notes" || !strings.HasSuffix(path, ".md") {
		t.Fatalf("stored upload %s = %q", path, data)
	}
	adapter := f.adapters[0]
	adapter.mu.Lock()
	prompt := adapter.fields[1]["content"].([]map[string]any)[0]["text"].(string)
	adapter.mu.Unlock()
	if !strings.HasPrefix(prompt, "read this\n\nAttached local files") || !strings.Contains(prompt, path) || !strings.Contains(prompt, `"name":"notes.md"`) {
		t.Fatalf("provider prompt = %q", prompt)
	}
	messages, _ := f.svc.Store().Messages(ctx, "conv-1")
	if len(messages) != 1 || messages[0].Content != "read this" || !strings.Contains(messages[0].AttachmentIds, a.ID) {
		t.Fatalf("stored message = %+v", messages)
	}

	other, _ := f.svc.Store().EnsureScope(ctx, store.Scope{APIOrigin: "https://api.multica.ai", UserID: "u", WorkspaceID: "other"})
	if _, _, err := f.svc.AttachmentFile(ctx, other, a.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("attachment across workspaces = %v", err)
	}
	if _, err := f.svc.Send(ctx, SendCommand{ScopeID: f.scopeID, ConversationID: "conv-1", RequestID: "r2", Text: "x", AttachmentIDs: []string{"missing"}}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown attachment = %v", err)
	}
	if _, err := f.svc.Upload(ctx, f.scopeID, "big.bin", "application/octet-stream", strings.NewReader(strings.Repeat("x", store.MaxUploadBytes+1))); !errors.Is(err, store.ErrUploadTooLarge) {
		t.Fatalf("oversized upload = %v", err)
	}
}

func TestPreviewStaysInsideReadableFolders(t *testing.T) {
	t.Parallel()

	f := newServiceFixture(t, filepath.Join(t.TempDir(), "c.sqlite"))
	ctx := context.Background()
	cwd, _ := filepath.EvalSymlinks(t.TempDir())
	if _, err := f.svc.Store().CreateConversation(ctx, store.NewConversation{ID: "conv-1", ScopeID: f.scopeID, Provider: "claude", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	must(t, os.WriteFile(filepath.Join(cwd, "a.png"), []byte("png"), 0o600))
	must(t, os.WriteFile(filepath.Join(cwd, "bin.txt"), []byte{0, 1}, 0o600))
	must(t, os.Mkdir(filepath.Join(cwd, "sub"), 0o700))
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	must(t, os.WriteFile(filepath.Join(outside, "secret.png"), []byte("png"), 0o600))
	must(t, os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(cwd, "link.png")))

	if img, err := f.svc.ConversationImage(ctx, f.scopeID, "conv-1", filepath.Join(cwd, "a.png")); err != nil || img.MimeType != "image/png" {
		t.Fatalf("image in cwd = %+v, %v", img, err)
	}
	for _, path := range []string{filepath.Join(outside, "secret.png"), filepath.Join(cwd, "link.png")} {
		if _, err := f.svc.ConversationImage(ctx, f.scopeID, "conv-1", path); !errors.Is(err, ErrOutsideFolder) {
			t.Errorf("image %s = %v", path, err)
		}
	}
	if _, err := f.svc.PreviewFile(ctx, f.scopeID, "conv-1", cwd, "../"+filepath.Base(outside)+"/secret.png"); !errors.Is(err, ErrOutsideFolder) {
		t.Fatalf("relative escape = %v", err)
	}
	if _, err := f.svc.PreviewFile(ctx, f.scopeID, "conv-1", cwd, "bin.txt"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("binary text = %v", err)
	}
	entries, err := f.svc.ListPreview(ctx, f.scopeID, "conv-1", cwd, ".")
	if err != nil || len(entries) != 3 || entries[0].Name != "sub" {
		t.Fatalf("list = %+v, %v", entries, err)
	}

	// Without the conversation, cwd is not readable until approved.
	if _, err := f.svc.LocatePreview(ctx, f.scopeID, "", filepath.Join(outside, "secret.png")); !errors.Is(err, ErrOutsideFolder) {
		t.Fatalf("unapproved folder = %v", err)
	}
	if _, err := f.svc.ApprovePreviewRoot(ctx, f.scopeID, outside); err != nil {
		t.Fatal(err)
	}
	if loc, err := f.svc.LocatePreview(ctx, f.scopeID, "", filepath.Join(outside, "secret.png")); err != nil || loc.Root != outside {
		t.Fatalf("approved folder = %+v, %v", loc, err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
