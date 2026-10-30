package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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
	Name string
	// FileName is the name the user gave the file, for uploads.
	FileName  string
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
	id, name, size, err := s.writeFile(bytes.NewReader(data), ext, MaxAttachmentBytes)
	if err != nil {
		return NewAttachment{}, err
	}
	return NewAttachment{ID: id, ScopeID: scopeID, ConversationID: conversationID, Name: name, Size: size, MediaType: mediaType, CreatedAt: now}, nil
}

// MaxUploadBytes bounds one file a user attaches to a message.
const MaxUploadBytes = 25 << 20

// ErrUploadTooLarge rejects an upload over MaxUploadBytes.
var ErrUploadTooLarge = errors.New("local conversation store: the file exceeds 25 MB")

// StoreUpload saves a file the user attaches to a message and commits it at
// once, so a later send can reference it.
func (s *Store) StoreUpload(ctx context.Context, scopeID int64, fileName, mediaType string, src io.Reader, now time.Time) (sqlitedb.Attachment, error) {
	ext, ok := mediaExtensions[mediaType]
	if !ok {
		if e := strings.ToLower(filepath.Ext(fileName)); safeExtension.MatchString(e) {
			ext = e
		}
	}
	id, name, size, err := s.writeFile(src, ext, MaxUploadBytes)
	if err != nil {
		return sqlitedb.Attachment{}, err
	}
	a := sqlitedb.Attachment{ID: id, ScopeID: scopeID, Path: name, FileName: fileName, Size: size, MediaType: mediaType, CreatedAt: formatTime(now)}
	err = sqlitedb.New(s.write).InsertAttachment(ctx, sqlitedb.InsertAttachmentParams{
		ID: a.ID, ScopeID: a.ScopeID, Path: a.Path, FileName: a.FileName, Size: a.Size, MediaType: a.MediaType, CreatedAt: a.CreatedAt,
	})
	if err != nil {
		_ = os.Remove(filepath.Join(s.FilesDir(), name))
		return sqlitedb.Attachment{}, err
	}
	return a, nil
}

var safeExtension = regexp.MustCompile(`^\.[a-z0-9]{1,16}$`)

// writeFile copies src to a private file under FilesDir: to a temporary
// name, synced, then renamed into place, so a crash never leaves a partial
// file under an attachment name. Empty files and files over limit fail.
func (s *Store) writeFile(src io.Reader, ext string, limit int64) (id, name string, size int64, err error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", "", 0, err
	}
	id = hex.EncodeToString(buf)
	dir := s.FilesDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", 0, err
	}
	tmp, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return "", "", 0, err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return "", "", 0, err
	}
	size, err = io.Copy(tmp, io.LimitReader(src, limit+1))
	if err == nil && size > limit {
		err = ErrUploadTooLarge
	}
	if err == nil && size == 0 {
		err = errors.New("local conversation store: the file is empty")
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", "", 0, err
	}
	name = id + ext
	if err := os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		return "", "", 0, err
	}
	return id, name, size, nil
}

// AddPreviewRoot lets the scope preview files under a folder the user chose.
func (s *Store) AddPreviewRoot(ctx context.Context, scopeID int64, path string, now time.Time) error {
	return sqlitedb.New(s.write).InsertPreviewRoot(ctx, sqlitedb.InsertPreviewRootParams{ScopeID: scopeID, Path: path, CreatedAt: formatTime(now)})
}

// PreviewRoots lists the folders the scope may preview files under.
func (s *Store) PreviewRoots(ctx context.Context, scopeID int64) ([]string, error) {
	return sqlitedb.New(s.read).ListPreviewRoots(ctx, scopeID)
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
