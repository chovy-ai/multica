package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// AddFolderProject records a project folder for the scope. A folder that is
// already recorded returns the existing project.
func (s *Store) AddFolderProject(ctx context.Context, scopeID int64, id, title, path string, at time.Time) (sqlitedb.FolderProject, error) {
	tx, err := s.write.BeginTx(ctx, nil)
	if err != nil {
		return sqlitedb.FolderProject{}, err
	}
	defer tx.Rollback()
	q := sqlitedb.New(tx)
	if existing, err := q.GetFolderProjectByPath(ctx, sqlitedb.GetFolderProjectByPathParams{ScopeID: scopeID, Path: path}); err == nil {
		return existing, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return sqlitedb.FolderProject{}, err
	}
	project := sqlitedb.FolderProject{ID: id, ScopeID: scopeID, Title: title, Path: path, CreatedAt: formatTime(at)}
	if err := q.InsertFolderProject(ctx, sqlitedb.InsertFolderProjectParams(project)); err != nil {
		return sqlitedb.FolderProject{}, err
	}
	return project, tx.Commit()
}

// FolderProjects lists the scope's project folders in the order they were added.
func (s *Store) FolderProjects(ctx context.Context, scopeID int64) ([]sqlitedb.FolderProject, error) {
	return sqlitedb.New(s.read).ListFolderProjects(ctx, scopeID)
}

// FolderProject returns one of the scope's project folders.
func (s *Store) FolderProject(ctx context.Context, scopeID int64, id string) (sqlitedb.FolderProject, error) {
	p, err := sqlitedb.New(s.read).GetFolderProject(ctx, sqlitedb.GetFolderProjectParams{ScopeID: scopeID, ID: id})
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// ConversationByCwd returns the scope's oldest conversation running in cwd.
func (s *Store) ConversationByCwd(ctx context.Context, scopeID int64, cwd string) (sqlitedb.Conversation, error) {
	c, err := sqlitedb.New(s.read).FindConversationByCwd(ctx, sqlitedb.FindConversationByCwdParams{ScopeID: scopeID, Cwd: cwd})
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	return c, err
}
