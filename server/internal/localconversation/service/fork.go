package service

import (
	"context"

	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/multica-ai/multica/server/pkg/codexappserver"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

var (
	// ErrForkUnavailable rejects a fork the provider history cannot serve.
	ErrForkUnavailable = errors.New("local conversation: this conversation cannot be forked here")
	// ErrForking rejects a second fork of a conversation while one runs.
	ErrForking = errors.New("local conversation: this conversation is already being forked")
)

// ForkCommand forks a conversation, through one of its turns or entirely.
type ForkCommand struct {
	ScopeID   int64
	SourceID  string
	TurnID    string
	RequestID string
}

// Fork asks the provider to fork its native session, then copies the
// history up to the same point into a new conversation. A retry with the
// same request id returns the same conversation.
func (s *Service) Fork(ctx context.Context, cmd ForkCommand) (sqlitedb.Conversation, error) {
	src, err := s.scopedConversation(ctx, cmd.ScopeID, cmd.SourceID)
	if err != nil {
		return src, err
	}
	if cmd.RequestID == "" {
		return src, fmt.Errorf("%w: request_id is required", ErrInvalidRequest)
	}
	sum := sha256.Sum256([]byte("fork\x00" + cmd.SourceID + "\x00" + cmd.TurnID))
	fingerprint := hex.EncodeToString(sum[:])
	if r, err := s.store.Receipt(ctx, cmd.ScopeID, cmd.RequestID); err == nil {
		if r.Fingerprint != fingerprint {
			return src, ErrRequestConflict
		}
		return s.store.Conversation(ctx, r.Result)
	}

	s.mu.Lock()
	if s.forking[cmd.SourceID] {
		s.mu.Unlock()
		return src, ErrForking
	}
	s.forking[cmd.SourceID] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.forking, cmd.SourceID)
		s.mu.Unlock()
	}()

	nativeBoundary, err := s.forkBoundary(ctx, src, cmd.TurnID)
	if err != nil {
		return src, err
	}
	title := truncateRunes(src.Title, 240) + " · Fork"
	nativeID, err := s.forkNative(ctx, src, nativeBoundary, title)
	if err != nil {
		return src, err
	}
	if nativeID == "" || nativeID == src.ProviderSessionID {
		return src, fmt.Errorf("%w: the provider did not create an independent conversation", ErrForkUnavailable)
	}
	id := newID()
	now := s.opts.Now()
	_, err = s.store.ForkConversation(ctx, store.ForkCopy{
		SourceID: src.ID, ID: id, Title: title, ThroughTurnID: cmd.TurnID, ProviderSessionID: nativeID, CreatedAt: now,
		Receipt: &store.CommandReceipt{ScopeID: cmd.ScopeID, RequestID: cmd.RequestID, Fingerprint: fingerprint, Result: id, CreatedAt: now},
	})
	if errors.Is(err, store.ErrDuplicateRequest) {
		return s.Fork(ctx, cmd)
	}
	if err != nil {
		return src, err
	}
	s.closeCopiedTasks(ctx, id)
	return s.publishCreated(ctx, id)
}

// forkBoundary checks the fork can be served and returns where it ends in
// the provider's history: empty for the whole session.
func (s *Service) forkBoundary(ctx context.Context, src sqlitedb.Conversation, turnID string) (string, error) {
	if src.TurnCount == 0 {
		return "", fmt.Errorf("%w: send a message before forking this conversation", ErrForkUnavailable)
	}
	if src.ProviderSessionID == "" {
		return "", fmt.Errorf("%w: this conversation has no saved native session to fork", ErrForkUnavailable)
	}
	if turnID == "" {
		running, err := s.store.RunningTurns(ctx)
		if err != nil {
			return "", err
		}
		for _, t := range running {
			if t.ConversationID == src.ID {
				return "", fmt.Errorf("%w: wait for the current execution to finish before forking", ErrTurnRunning)
			}
		}
		return "", nil
	}
	turn, err := s.store.Turn(ctx, src.ID, turnID)
	if err != nil {
		return "", fmt.Errorf("%w: turn %s", store.ErrNotFound, turnID)
	}
	if turn.Status == "running" {
		return "", fmt.Errorf("%w: wait for the selected execution to finish before forking", ErrTurnRunning)
	}
	if turn.ProviderTurnID == "" {
		return "", fmt.Errorf("%w: this turn has no native provider binding", ErrForkUnavailable)
	}
	return turn.ProviderTurnID, nil
}

// forkNative forks the provider session without submitting a prompt and
// returns the new native session id.
func (s *Service) forkNative(ctx context.Context, src sqlitedb.Conversation, boundary, title string) (string, error) {
	switch {
	case src.Provider == "claude" && s.opts.Claude != nil:
		_, start, err := s.opts.Claude(ctx, src)
		if err != nil {
			return "", err
		}
		adapter, err := start(ctx, func(claude.Output) {})
		if err != nil {
			return "", err
		}
		defer adapter.Close(context.Background())
		fields := map[string]any{"session_id": src.ProviderSessionID, "dir": src.Cwd, "title": title}
		if boundary != "" {
			fields["up_to_message_id"] = boundary
		}
		raw, err := adapter.Request(ctx, "fork_session", fields)
		if err != nil {
			return "", err
		}
		var result struct {
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(raw, &result)
		return result.SessionID, nil
	case src.Provider == "codex" && s.opts.Codex != nil:
		_, start, err := s.opts.Codex(ctx, src)
		if err != nil {
			return "", err
		}
		server, err := start(ctx, func(codexappserver.Frame) {}, nil)
		if err != nil {
			return "", err
		}
		defer server.Stop()
		params := map[string]any{"threadId": src.ProviderSessionID}
		if boundary != "" {
			params["lastTurnId"] = boundary
			params["excludeTurns"] = false
		}
		raw, err := server.Request(ctx, "thread/fork", params)
		if err != nil {
			return "", err
		}
		var result struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		_ = json.Unmarshal(raw, &result)
		return result.Thread.ID, nil
	}
	return "", fmt.Errorf("%w: %s", ErrUnsupportedProvider, src.Provider)
}

// closeCopiedTasks ends background tasks the copy shows as running: they
// keep running only in the source conversation.
func (s *Service) closeCopiedTasks(ctx context.Context, conversationID string) {
	rows, err := s.store.OpenBackgroundTaskItems(ctx, conversationID)
	if err != nil || len(rows) == 0 {
		return
	}
	batch := store.Batch{ConversationID: conversationID}
	now := s.opts.Now()
	for _, row := range rows {
		var state map[string]any
		_ = json.Unmarshal([]byte(row.Payload), &state)
		state["status"] = "cancelled"
		state["summary"] = "Background task belongs to the source conversation."
		payload, _ := json.Marshal(state)
		batch.Events = append(batch.Events, store.NewEvent{TurnID: row.TurnID.String, ItemID: row.ItemID.String, Type: "item.completed", Final: true, Payload: payload, CreatedAt: now})
	}
	_, _ = s.batcher.AppendWait(ctx, batch)
}
