// Package store persists local conversations in one SQLite WAL database per
// daemon profile. One writer connection serializes all writes (see Writer);
// a bounded pool of read-only connections serves snapshots, history and
// catch-up replay.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
	_ "modernc.org/sqlite"
)

//go:embed schema/*.sql
var schemaFS embed.FS

// ErrUnsupportedSchema means the database was written by a newer daemon.
var ErrUnsupportedSchema = errors.New("local conversation store: unsupported schema version")

const (
	busyTimeout      = 5 * time.Second
	readConns        = 4
	journalSizeLimit = 64 << 20
	generationKey    = "store_generation"
)

// Store is an open conversation database.
type Store struct {
	path       string
	write      *sql.DB
	read       *sql.DB
	generation string
}

// Open opens or creates the database at path and upgrades its schema.
func Open(ctx context.Context, path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	write, err := sql.Open("sqlite", dsn(path, writePragmas, "immediate"))
	if err != nil {
		return nil, err
	}
	write.SetMaxOpenConns(1)
	s := &Store{path: path, write: write}
	if err := s.verifyWritePragmas(ctx); err != nil {
		write.Close()
		return nil, err
	}
	if err := s.migrate(ctx); err != nil {
		write.Close()
		return nil, err
	}
	if err := s.loadGeneration(ctx); err != nil {
		write.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		write.Close()
		return nil, err
	}
	read, err := sql.Open("sqlite", dsn(path, readPragmas, "deferred"))
	if err != nil {
		write.Close()
		return nil, err
	}
	read.SetMaxOpenConns(readConns)
	s.read = read
	return s, nil
}

// Close closes both connection pools.
func (s *Store) Close() error {
	return errors.Join(s.read.Close(), s.write.Close())
}

// Generation identifies this database file. It changes only when the file is
// replaced, which invalidates every client cursor.
func (s *Store) Generation() string { return s.generation }

var writePragmas = []string{
	"journal_mode(WAL)",
	"synchronous(FULL)",
	// macOS fsync does not reach the medium; committed data must survive
	// power loss.
	"fullfsync(1)",
	"checkpoint_fullfsync(1)",
	"busy_timeout(" + strconv.Itoa(int(busyTimeout/time.Millisecond)) + ")",
	"journal_size_limit(" + strconv.Itoa(journalSizeLimit) + ")",
}

var readPragmas = []string{
	"busy_timeout(" + strconv.Itoa(int(busyTimeout/time.Millisecond)) + ")",
	"query_only(1)",
}

// dsn builds a modernc.org/sqlite DSN. The writer takes the write lock when a
// transaction begins (immediate) so a busy database fails at BEGIN rather than
// mid-transaction; readers use deferred transactions.
func dsn(path string, pragmas []string, txlock string) string {
	q := url.Values{}
	for _, p := range pragmas {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", txlock)
	return "file:" + path + "?" + q.Encode()
}

// verifyWritePragmas checks the effective values instead of trusting the DSN.
func (s *Store) verifyWritePragmas(ctx context.Context) error {
	want := map[string]string{
		"journal_mode":         "wal",
		"synchronous":          "2",
		"fullfsync":            "1",
		"checkpoint_fullfsync": "1",
		"busy_timeout":         strconv.Itoa(int(busyTimeout / time.Millisecond)),
	}
	for name, value := range want {
		var got string
		if err := s.write.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil {
			return fmt.Errorf("read PRAGMA %s: %w", name, err)
		}
		if strings.ToLower(got) != value {
			return fmt.Errorf("PRAGMA %s = %s, want %s", name, got, value)
		}
	}
	return nil
}

type schemaVersion struct {
	version int
	file    string
}

func schemaVersions() ([]schemaVersion, error) {
	entries, err := fs.ReadDir(schemaFS, "schema")
	if err != nil {
		return nil, err
	}
	var versions []schemaVersion
	for _, e := range entries {
		prefix, _, ok := strings.Cut(e.Name(), "_")
		n, err := strconv.Atoi(prefix)
		if !ok || err != nil {
			return nil, fmt.Errorf("schema file %s must start with its version number", e.Name())
		}
		versions = append(versions, schemaVersion{version: n, file: "schema/" + e.Name()})
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].version < versions[j].version })
	for i, v := range versions {
		if v.version != i+1 {
			return nil, fmt.Errorf("schema versions must be contiguous from 1, found %d at position %d", v.version, i+1)
		}
	}
	return versions, nil
}

// migrate applies pending schema versions in one transaction. An existing
// database is copied with VACUUM INTO first so a failed upgrade leaves a
// restorable backup next to it.
func (s *Store) migrate(ctx context.Context) error {
	versions, err := schemaVersions()
	if err != nil {
		return err
	}
	latest := len(versions)
	var current int
	if err := s.write.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	switch {
	case current > latest:
		return fmt.Errorf("%w: database is version %d, this daemon supports %d", ErrUnsupportedSchema, current, latest)
	case current == latest:
		return nil
	case current > 0:
		backup := fmt.Sprintf("%s.v%d.bak", s.path, current)
		_ = os.Remove(backup)
		if _, err := s.write.ExecContext(ctx, "VACUUM INTO ?", backup); err != nil {
			return fmt.Errorf("back up before schema upgrade: %w", err)
		}
	}

	tx, err := s.write.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, v := range versions[current:] {
		ddl, err := schemaFS.ReadFile(v.file)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(ddl)); err != nil {
			return fmt.Errorf("apply %s: %w", v.file, err)
		}
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", latest)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) loadGeneration(ctx context.Context) error {
	q := sqlitedb.New(s.write)
	generation, err := q.GetMeta(ctx, generationKey)
	if errors.Is(err, sql.ErrNoRows) {
		buf := make([]byte, 16)
		if _, err := rand.Read(buf); err != nil {
			return err
		}
		generation = hex.EncodeToString(buf)
		err = q.PutMeta(ctx, sqlitedb.PutMetaParams{Key: generationKey, Value: generation})
	}
	if err != nil {
		return err
	}
	s.generation = generation
	return nil
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
