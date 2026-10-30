package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

var (
	// ErrInteractionExists means an interaction with the same id exists.
	ErrInteractionExists = errors.New("local conversation store: interaction already exists")
	// ErrInteractionClosed means the interaction is no longer pending.
	ErrInteractionClosed = errors.New("local conversation store: interaction is no longer pending")
)

// NewInteraction is a permission request or user question to persist.
type NewInteraction struct {
	ID                string
	TurnID            string
	ProviderRequestID string
	Kind              string
	Request           json.RawMessage
	CreatedAt         time.Time
}

// InteractionResolution answers or cancels a pending interaction. The
// update applies only while the interaction is pending, so the first
// answer wins.
type InteractionResolution struct {
	ID     string
	Status string // answered or cancelled
	Answer json.RawMessage
	By     string
	At     time.Time
	// IgnoreClosed skips an interaction that is no longer pending instead
	// of rejecting the batch; cancellations use it.
	IgnoreClosed bool
}

// Interaction returns one interaction.
func (s *Store) Interaction(ctx context.Context, id string) (sqlitedb.InteractionRequest, error) {
	row, err := sqlitedb.New(s.read).GetInteraction(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return row, fmt.Errorf("%w: interaction %s", ErrNotFound, id)
	}
	return row, err
}

// PendingTurnInteractions lists a turn's pending interactions.
func (s *Store) PendingTurnInteractions(ctx context.Context, conversationID, turnID string) ([]sqlitedb.InteractionRequest, error) {
	return sqlitedb.New(s.read).ListPendingTurnInteractions(ctx, sqlitedb.ListPendingTurnInteractionsParams{ConversationID: conversationID, TurnID: turnID})
}

// applyInteractions writes a batch's interactions and returns the
// conversation's pending count when it may have changed.
func applyInteractions(ctx context.Context, q *sqlitedb.Queries, conv sqlitedb.Conversation, b Batch) (int64, bool, error) {
	if len(b.Interactions) == 0 && len(b.Resolutions) == 0 {
		return 0, false, nil
	}
	for _, in := range b.Interactions {
		err := q.InsertInteraction(ctx, sqlitedb.InsertInteractionParams{
			ID: in.ID, ConversationID: conv.ID, TurnID: in.TurnID, ProviderRequestID: in.ProviderRequestID,
			Kind: in.Kind, Payload: string(in.Request), CreatedAt: formatTime(in.CreatedAt),
		})
		if err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return 0, false, fmt.Errorf("%w: %s", ErrInteractionExists, in.ID)
		}
		if err != nil {
			return 0, false, err
		}
	}
	for _, r := range b.Resolutions {
		row, err := q.GetInteraction(ctx, r.ID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && row.ConversationID != conv.ID) {
			return 0, false, fmt.Errorf("%w: interaction %s", ErrNotFound, r.ID)
		}
		if err != nil {
			return 0, false, err
		}
		answer := sql.NullString{}
		if len(r.Answer) > 0 {
			answer = sql.NullString{String: string(r.Answer), Valid: true}
		}
		n, err := q.ResolveInteraction(ctx, sqlitedb.ResolveInteractionParams{
			Status: r.Status, Answer: answer, AnsweredByConnection: r.By, ResolvedAt: sql.NullString{String: formatTime(r.At), Valid: true}, ID: r.ID,
		})
		if err != nil {
			return 0, false, err
		}
		if n == 0 && !r.IgnoreClosed {
			return 0, false, fmt.Errorf("%w: %s", ErrInteractionClosed, r.ID)
		}
	}
	count, err := q.CountPendingInteractions(ctx, conv.ID)
	return count, true, err
}

// interactionTime is when a batch's interaction changes happened.
func interactionTime(b Batch) time.Time {
	var t time.Time
	for _, in := range b.Interactions {
		if in.CreatedAt.After(t) {
			t = in.CreatedAt
		}
	}
	for _, r := range b.Resolutions {
		if r.At.After(t) {
			t = r.At
		}
	}
	return t
}
