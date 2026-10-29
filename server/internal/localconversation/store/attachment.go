package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// MaxAttachmentBytes bounds one attachment file.
const MaxAttachmentBytes = 32 << 20

const tempPrefix = ".tmp-"

var mediaExtensions = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

// NewAttachment is an attachment file already written, committed by a Batch.
type NewAttachment struct {
	ID             string
	ScopeID        int64
	ConversationID string
	// Name is the file name under FilesDir.
	Name      string
	Size      int64
	MediaType string
	CreatedAt time.Time
}

// FilesDir holds attachment files, next to the database.
func (s *Store) FilesDir() string { return filepath.Join(filepath.Dir(s.path), "files") }

// WriteAttachmentFile writes data as a private file under FilesDir: to a
// temporary name, synced, then renamed into place, so a crash never leaves
// a partial file under an attachment name. The attachment becomes visible
// only when a Batch commits it; a file whose batch never commits is removed
// by RemoveUnreferencedFiles.
func (s *Store) WriteAttachmentFile(scopeID int64, conversationID, mediaType string, data []byte, now time.Time) (NewAttachment, error) {
	ext, ok := mediaExtensions[mediaType]
	if !ok {
		return NewAttachment{}, fmt.Errorf("local conversation store: unsupported attachment type %q", mediaType)
	}
	if len(data) == 0 || len(data) > MaxAttachmentBytes {
		return NewAttachment{}, fmt.Errorf("local conversation store: attachment size %d outside 1..%d", len(data), MaxAttachmentBytes)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return NewAttachment{}, err
	}
	id := hex.EncodeToString(buf)
	dir := s.FilesDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return NewAttachment{}, err
	}
	tmp, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return NewAttachment{}, err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return NewAttachment{}, err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return NewAttachment{}, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return NewAttachment{}, err
	}
	if err := tmp.Close(); err != nil {
		return NewAttachment{}, err
	}
	name := id + ext
	if err := os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		return NewAttachment{}, err
	}
	return NewAttachment{ID: id, ScopeID: scopeID, ConversationID: conversationID, Name: name, Size: int64(len(data)), MediaType: mediaType, CreatedAt: now}, nil
}

// Attachment returns a committed attachment and its file path. scopeID must
// match: an attachment is never served across accounts or workspaces.
func (s *Store) Attachment(ctx context.Context, scopeID int64, id string) (sqlitedb.Attachment, string, error) {
	a, err := sqlitedb.New(s.read).GetAttachment(ctx, id)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && a.ScopeID != scopeID) {
		return sqlitedb.Attachment{}, "", fmt.Errorf("%w: attachment %s", ErrNotFound, id)
	}
	if err != nil {
		return sqlitedb.Attachment{}, "", err
	}
	return a, filepath.Join(s.FilesDir(), a.Path), nil
}

// RemoveUnreferencedFiles deletes files under FilesDir that no committed
// attachment references and that are older than minAge, so files of batches
// still being committed are kept. It returns the number removed.
func (s *Store) RemoveUnreferencedFiles(ctx context.Context, minAge time.Duration, now time.Time) (int, error) {
	entries, err := os.ReadDir(s.FilesDir())
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	q := sqlitedb.New(s.read)
	removed := 0
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < minAge {
			continue
		}
		if !strings.HasPrefix(e.Name(), tempPrefix) {
			n, err := q.CountAttachmentsAtPath(ctx, e.Name())
			if err != nil {
				return removed, err
			}
			if n > 0 {
				continue
			}
		}
		if err := os.Remove(filepath.Join(s.FilesDir(), e.Name())); err == nil {
			removed++
		}
	}
	return removed, nil
}
