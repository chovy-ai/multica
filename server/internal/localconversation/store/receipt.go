package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

var (
	// ErrDuplicateRequest means a receipt with the same request id exists.
	ErrDuplicateRequest = errors.New("local conversation store: request id already used")
)

// CommandReceipt records that a command was accepted, in the same
// transaction as its effects, so a retry with the same request id returns
// the same result instead of running the command again.
type CommandReceipt struct {
	ScopeID     int64
	RequestID   string
	Fingerprint string
	// Result is what the command returned to its caller, e.g. a turn id.
	Result    string
	CreatedAt time.Time
}

// Receipt returns the receipt for requestID, or ErrNotFound.
func (s *Store) Receipt(ctx context.Context, scopeID int64, requestID string) (sqlitedb.CommandReceipt, error) {
	r, err := sqlitedb.New(s.read).GetCommandReceipt(ctx, sqlitedb.GetCommandReceiptParams{ScopeID: scopeID, RequestID: requestID})
	if errors.Is(err, sql.ErrNoRows) {
		return r, fmt.Errorf("%w: request %s", ErrNotFound, requestID)
	}
	return r, err
}

// MarkUncertain records that a command was accepted but whether its effect
// reached the provider is unknown; it must not be replayed automatically.
func (s *Store) MarkUncertain(ctx context.Context, scopeID int64, requestID string) error {
	return sqlitedb.New(s.write).MarkCommandUncertain(ctx, sqlitedb.MarkCommandUncertainParams{ScopeID: scopeID, RequestID: requestID})
}

func insertReceipt(ctx context.Context, q *sqlitedb.Queries, r CommandReceipt) error {
	err := q.InsertCommandReceipt(ctx, sqlitedb.InsertCommandReceiptParams{
		ScopeID: r.ScopeID, RequestID: r.RequestID, Fingerprint: r.Fingerprint, Result: r.Result, CreatedAt: formatTime(r.CreatedAt),
	})
	if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
		return fmt.Errorf("%w: %s", ErrDuplicateRequest, r.RequestID)
	}
	return err
}

// ClaimReceipt records a pending operation under requestID before it runs.
// When requestID was claimed before it returns that receipt instead; the
// caller compares fingerprints.
func (s *Store) ClaimReceipt(ctx context.Context, r CommandReceipt) (existing *sqlitedb.CommandReceipt, err error) {
	err = insertReceipt(ctx, sqlitedb.New(s.write), r)
	if errors.Is(err, ErrDuplicateRequest) {
		prior, err := s.Receipt(ctx, r.ScopeID, r.RequestID)
		if err != nil {
			return nil, err
		}
		return &prior, nil
	}
	return nil, err
}

// SetReceiptResult records the outcome of a claimed operation.
func (s *Store) SetReceiptResult(ctx context.Context, scopeID int64, requestID, result string) error {
	return sqlitedb.New(s.write).SetCommandReceiptResult(ctx, sqlitedb.SetCommandReceiptResultParams{Result: result, ScopeID: scopeID, RequestID: requestID})
}
