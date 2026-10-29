package store

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var pngBytes = []byte("\x89PNG\r\n\x1a\nfake")

func TestAttachmentFileIsCommittedWithItsBatchAndScoped(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	scopeID := createConversation(t, s, "conv-1")
	ctx := context.Background()
	a, err := s.WriteAttachmentFile(scopeID, "conv-1", "image/png", pngBytes, testTime)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(s.FilesDir(), a.Name))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || !strings.HasSuffix(a.Name, ".png") {
		t.Fatalf("file %s mode %v", a.Name, info.Mode().Perm())
	}
	// Not visible until a batch commits it.
	if _, _, err := s.Attachment(ctx, scopeID, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("uncommitted attachment = %v", err)
	}

	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv-1", Attachments: []NewAttachment{a},
		Events: []NewEvent{event("", "img-1", "item.completed", true, `{"kind":"image","attachment_id":"`+a.ID+`"}`)}}); err != nil {
		t.Fatal(err)
	}
	row, path, err := s.Attachment(ctx, scopeID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, pngBytes) || row.MediaType != "image/png" || row.Size != int64(len(pngBytes)) {
		t.Fatalf("attachment %+v at %s = %q, %v", row, path, data, err)
	}
	if _, _, err := s.Attachment(ctx, scopeID+1, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attachment read from another scope = %v", err)
	}
}

func TestWriteAttachmentFileRejectsUnsupportedInput(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	if _, err := s.WriteAttachmentFile(1, "conv-1", "image/svg+xml", pngBytes, testTime); err == nil {
		t.Fatal("svg accepted")
	}
	if _, err := s.WriteAttachmentFile(1, "conv-1", "image/png", nil, testTime); err == nil {
		t.Fatal("empty file accepted")
	}
}

func TestBatchRejectsAttachmentOfAnotherConversation(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	scopeID := createConversation(t, s, "conv-1")
	createConversation(t, s, "conv-2")
	a, err := s.WriteAttachmentFile(scopeID, "conv-2", "image/png", pngBytes, testTime)
	if err != nil {
		t.Fatal(err)
	}
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	if _, err := w.Submit(context.Background(), Batch{ConversationID: "conv-1", Attachments: []NewAttachment{a}}); err == nil {
		t.Fatal("attachment of conv-2 committed into conv-1")
	}
}

func TestRemoveUnreferencedFilesKeepsCommittedAndRecentFiles(t *testing.T) {
	t.Parallel()

	s, _ := openTestStore(t)
	scopeID := createConversation(t, s, "conv-1")
	ctx := context.Background()
	committed, _ := s.WriteAttachmentFile(scopeID, "conv-1", "image/png", pngBytes, testTime)
	orphan, _ := s.WriteAttachmentFile(scopeID, "conv-1", "image/png", pngBytes, testTime)
	if err := os.WriteFile(filepath.Join(s.FilesDir(), tempPrefix+"leftover"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := s.NewWriter(WriterOptions{})
	defer w.Close()
	if _, err := w.Submit(ctx, Batch{ConversationID: "conv-1", Attachments: []NewAttachment{committed}}); err != nil {
		t.Fatal(err)
	}

	// Files younger than minAge may belong to a batch still committing.
	if n, err := s.RemoveUnreferencedFiles(ctx, time.Hour, time.Now()); err != nil || n != 0 {
		t.Fatalf("removed %d recent files, %v", n, err)
	}
	n, err := s.RemoveUnreferencedFiles(ctx, time.Hour, time.Now().Add(2*time.Hour))
	if err != nil || n != 2 {
		t.Fatalf("removed %d, %v; want orphan and temp file", n, err)
	}
	if _, err := os.Stat(filepath.Join(s.FilesDir(), committed.Name)); err != nil {
		t.Fatalf("committed file removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.FilesDir(), orphan.Name)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan file kept: %v", err)
	}
}
