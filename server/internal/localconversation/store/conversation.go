package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

// ErrNotFound reports a missing conversation or turn.
var ErrNotFound = errors.New("local conversation store: not found")

// Scope identifies one API origin, account and workspace.
type Scope struct {
	APIOrigin   string
	UserID      string
	WorkspaceID string
}

// EnsureScope returns the id of scope, creating it on first use.
func (s *Store) EnsureScope(ctx context.Context, scope Scope) (int64, error) {
	tx, err := s.write.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	q := sqlitedb.New(tx)
	id, err := q.GetScopeID(ctx, sqlitedb.GetScopeIDParams{ApiOrigin: scope.APIOrigin, UserID: scope.UserID, WorkspaceID: scope.WorkspaceID})
	if errors.Is(err, sql.ErrNoRows) {
		id, err = q.InsertScope(ctx, sqlitedb.InsertScopeParams{ApiOrigin: scope.APIOrigin, UserID: scope.UserID, WorkspaceID: scope.WorkspaceID})
	}
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

// NewConversation describes a conversation to create.
type NewConversation struct {
	ID                    string
	ScopeID               int64
	Provider              string
	ProviderSessionID     string
	Title                 string
	Cwd                   string
	Model                 *string
	ReasoningEffort       *string
	PermissionMode        string
	ProjectID             *string
	SideSourceID          string
	ForkedFromID          string
	ForkedFromTurnID      string
	ImportedFromSessionID string
	CreatedAt             time.Time
}

// CreateConversation inserts a conversation and publishes it in the scope's
// summary stream. It returns the new scope sequence.
func (s *Store) CreateConversation(ctx context.Context, c NewConversation) (int64, error) {
	tx, err := s.write.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	q := sqlitedb.New(tx)
	scopeSeq, err := q.BumpScopeSeq(ctx, c.ScopeID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	permission := c.PermissionMode
	if permission == "" {
		permission = "default"
	}
	now := formatTime(c.CreatedAt)
	err = q.InsertConversation(ctx, sqlitedb.InsertConversationParams{
		ID:                    c.ID,
		ScopeID:               c.ScopeID,
		Provider:              c.Provider,
		ProviderSessionID:     c.ProviderSessionID,
		Title:                 c.Title,
		TitleMode:             "auto",
		Cwd:                   c.Cwd,
		Model:                 nullString(c.Model),
		ReasoningEffort:       nullString(c.ReasoningEffort),
		PermissionMode:        permission,
		ProjectID:             nullString(c.ProjectID),
		SideSourceID:          c.SideSourceID,
		ForkedFromID:          c.ForkedFromID,
		ForkedFromTurnID:      c.ForkedFromTurnID,
		ImportedFromSessionID: c.ImportedFromSessionID,
		SummarySeq:            scopeSeq,
		CreatedAt:             now,
		UpdatedAt:             now,
	})
	if err != nil {
		return 0, err
	}
	return scopeSeq, tx.Commit()
}

func nullString(v *string) sql.NullString {
	if v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}
