package agentmemory

import (
	"database/sql"
	"errors"
	"os"
	"strings"

	_ "modernc.org/sqlite"
)

const ftsSchema = `CREATE TABLE IF NOT EXISTS entries(path TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(title,description,body,content='entries',content_rowid='rowid',tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid,title,description,body) VALUES(new.rowid,new.title,new.description,new.body); END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts,rowid,title,description,body) VALUES('delete',old.rowid,old.title,old.description,old.body); END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN INSERT INTO entries_fts(entries_fts,rowid,title,description,body) VALUES('delete',old.rowid,old.title,old.description,old.body); INSERT INTO entries_fts(rowid,title,description,body) VALUES(new.rowid,new.title,new.description,new.body); END;`

// The database is a disposable projection. Short-lived handles let a deleted or
// corrupt index recover without retaining stale SQLite handles across requests.
func (m *Manager) ftsPath(id string) (string, error) {
	root, err := m.Root(id)
	if err != nil {
		return "", err
	}
	path, err := safePath(root, ".multica/index.db")
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(root+"/.multica", 0700); err != nil {
		return "", err
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err = safePath(root, ".multica/index.db"+suffix); err != nil {
			return "", err
		}
	}
	return path, nil
}
func (m *Manager) rebuildFTS(id string) error {
	path, err := m.ftsPath(id)
	if err != nil {
		return err
	}
	entries, err := m.entries(id)
	if err != nil {
		return err
	}
	rebuild := func() error {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			return err
		}
		defer db.Close()
		db.SetMaxOpenConns(1)
		if _, err = db.Exec(ftsSchema); err != nil {
			return err
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.Exec("DELETE FROM entries"); err != nil {
			return err
		}
		for _, e := range entries {
			if _, err = tx.Exec("INSERT INTO entries VALUES(?,?,?,?,?)", e.Path, e.Title, e.Description, e.Body, e.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z")); err != nil {
				return err
			}
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		return os.Chmod(path, 0600)
	}
	if err = rebuild(); err == nil {
		return nil
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return rebuild()
}
func (m *Manager) Search(id, query string, limit int) ([]SearchHit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, ErrInvalidInput
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	defer m.lock(id)()
	// Reconcile from source files on each search, including external edits.
	if err := m.rebuildFTS(id); err != nil {
		return nil, err
	}
	path, err := m.ftsPath(id)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	terms := strings.Fields(query)
	for i := range terms {
		terms[i] = `"` + strings.ReplaceAll(terms[i], `"`, `""`) + `"`
	}
	rows, err := db.Query(`SELECT e.path,e.title,snippet(entries_fts,-1,'[',']','…',12) FROM entries_fts JOIN entries e ON e.rowid=entries_fts.rowid WHERE entries_fts MATCH ? ORDER BY bm25(entries_fts),e.path LIMIT ?`, strings.Join(terms, " "), limit)
	if err != nil {
		return nil, err
	}
	hits := []SearchHit{}
	seen := map[string]bool{}
	for rows.Next() {
		var h SearchHit
		if err = rows.Scan(&h.Path, &h.Title, &h.Snippet); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, h)
		seen[h.Path] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(hits) >= limit {
		return hits, nil
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	pattern := "%" + escaped + "%"
	rows, err = db.Query(`SELECT path,title,description,body FROM entries WHERE title LIKE ? ESCAPE '\' OR description LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\' ORDER BY path`, pattern, pattern, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var path, title, description, body string
		if err = rows.Scan(&path, &title, &description, &body); err != nil {
			return nil, err
		}
		if seen[path] {
			continue
		}
		text := title + " " + description + " " + body
		hits = append(hits, SearchHit{path, title, substringSnippet(text, query)})
		if len(hits) == limit {
			break
		}
	}
	return hits, rows.Err()
}
func substringSnippet(text, query string) string {
	r := []rune(text)
	pos := strings.Index(strings.ToLower(text), strings.ToLower(query))
	start := 0
	if pos >= 0 {
		start = len([]rune(text[:pos])) - 30
	}
	if start < 0 {
		start = 0
	}
	end := start + 60 + len([]rune(query))
	if end > len(r) {
		end = len(r)
	}
	return string(r[start:end])
}
