package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/store"
	"github.com/multica-ai/multica/server/internal/localconversation/store/sqlitedb"
)

var (
	// ErrRequestConflict means a request id was reused for different content.
	ErrRequestConflict = errors.New("local conversation: request id reused with different content")
	// ErrUnsupportedProvider means no runner serves the conversation's provider.
	ErrUnsupportedProvider = errors.New("local conversation: provider not supported by this daemon")
)

const (
	unreferencedFileAge = time.Hour
	closeTimeout        = 10 * time.Second
	snapshotTurns       = 20
)

// ClaudeLauncher prepares how a Claude conversation's adapter is started:
// its start fields (executable, cwd, model, MCP, settings) and the process
// launcher. The daemon resolves executables and credentials here.
type ClaudeLauncher func(ctx context.Context, conv sqlitedb.Conversation) (ClaudeSession, StartClaudeAdapter, error)

// Options configures Open.
type Options struct {
	Path           string
	Claude         ClaudeLauncher
	ContextMCPName string
	Logger         *slog.Logger
	Now            func() time.Time
}

// Service is the Go-owned local conversation service: one store, one
// writer, one batcher, one subscription hub, and one runner per active
// conversation.
type Service struct {
	store   *store.Store
	writer  *store.Writer
	batcher *Batcher
	hub     *Hub
	limiter *Limiter
	opts    Options

	mu      sync.Mutex
	runners map[string]*ClaudeRunner
}

// Open opens the store, closes turns a previous daemon left running, removes
// unreferenced attachment files, and starts the write path.
func Open(ctx context.Context, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	st, err := store.Open(ctx, opts.Path)
	if err != nil {
		return nil, err
	}
	writer := st.NewWriter(store.WriterOptions{})
	closed, err := ReconcileInterruptedTurns(ctx, st, writer, opts.Now())
	if err != nil {
		writer.Close()
		_ = st.Close()
		return nil, fmt.Errorf("reconcile interrupted turns: %w", err)
	}
	if closed > 0 {
		opts.Logger.Info("local conversations: closed turns interrupted by restart", "turns", closed)
	}
	if removed, err := st.RemoveUnreferencedFiles(ctx, unreferencedFileAge, opts.Now()); err != nil {
		opts.Logger.Warn("local conversations: attachment cleanup failed", "error", err)
	} else if removed > 0 {
		opts.Logger.Info("local conversations: removed unreferenced attachment files", "files", removed)
	}
	s := &Service{store: st, writer: writer, hub: NewHub(st, HubOptions{}), limiter: NewLimiter(MaxRunningTurns), opts: opts, runners: map[string]*ClaudeRunner{}}
	s.batcher = NewBatcher(writer, BatcherOptions{
		Published: s.hub.Publish,
		Failed: func(id string, err error) {
			if !errors.Is(err, store.ErrDuplicateRequest) {
				opts.Logger.Error("local conversations: commit failed", "conversation_id", id, "error", err)
			}
		},
	})
	return s, nil
}

// Close stops every runner, commits pending output and closes the store.
func (s *Service) Close(ctx context.Context) error {
	s.mu.Lock()
	runners := s.runners
	s.runners = map[string]*ClaudeRunner{}
	s.mu.Unlock()
	var errs []error
	for _, r := range runners {
		closeCtx, cancel := context.WithTimeout(ctx, closeTimeout)
		errs = append(errs, r.Close(closeCtx))
		cancel()
	}
	s.batcher.Close()
	s.writer.Close()
	errs = append(errs, s.store.Close())
	return errors.Join(errs...)
}

// Store exposes reads for the HTTP layer.
func (s *Service) Store() *store.Store { return s.store }

// Hub exposes subscriptions for the WS layer.
func (s *Service) Hub() *Hub { return s.hub }

// Generation identifies the database for client cursors.
func (s *Service) Generation() string { return s.store.Generation() }

// SendCommand is one user message from Desktop.
type SendCommand struct {
	ScopeID        int64
	ConversationID string
	RequestID      string
	Text           string
	Content        []map[string]any
}

// SendResult reports the accepted turn. Replayed is set when the request id
// was already accepted and this call returned the original result.
type SendResult struct {
	TurnID   string
	Replayed bool
}

// Send accepts a user message idempotently: a retry with the same request
// id and content returns the original turn; different content is rejected.
func (s *Service) Send(ctx context.Context, cmd SendCommand) (SendResult, error) {
	conv, err := s.scopedConversation(ctx, cmd.ScopeID, cmd.ConversationID)
	if err != nil {
		return SendResult{}, err
	}
	fingerprint := sendFingerprint(cmd)
	if result, done, err := s.replay(ctx, cmd.ScopeID, cmd.RequestID, fingerprint); done || err != nil {
		return result, err
	}
	runner, err := s.runner(ctx, conv)
	if err != nil {
		return SendResult{}, err
	}
	turnID := "turn-" + cmd.RequestID
	err = runner.Send(ctx, SendRequest{TurnID: turnID, RequestID: cmd.RequestID, Fingerprint: fingerprint, MessageID: "msg-" + cmd.RequestID, Text: cmd.Text, Content: cmd.Content})
	switch {
	case errors.Is(err, store.ErrDuplicateRequest):
		// A concurrent retry committed first.
		if result, done, err := s.replay(ctx, cmd.ScopeID, cmd.RequestID, fingerprint); done || err != nil {
			return result, err
		}
		return SendResult{}, err
	case errors.Is(err, ErrOutcomeUnknown):
		if markErr := s.store.MarkUncertain(ctx, cmd.ScopeID, cmd.RequestID); markErr != nil {
			err = errors.Join(err, markErr)
		}
		return SendResult{TurnID: turnID}, err
	case err != nil:
		return SendResult{}, err
	}
	return SendResult{TurnID: turnID}, nil
}

// Interrupt stops the conversation's running turn, if any.
func (s *Service) Interrupt(ctx context.Context, scopeID int64, conversationID string) error {
	if _, err := s.scopedConversation(ctx, scopeID, conversationID); err != nil {
		return err
	}
	s.mu.Lock()
	r := s.runners[conversationID]
	s.mu.Unlock()
	if r == nil {
		return nil
	}
	return r.Interrupt(ctx)
}

// Snapshot returns the conversation's first screen.
func (s *Service) Snapshot(ctx context.Context, scopeID int64, conversationID string) (store.Snapshot, error) {
	if _, err := s.scopedConversation(ctx, scopeID, conversationID); err != nil {
		return store.Snapshot{}, err
	}
	return s.store.Snapshot(ctx, conversationID, snapshotTurns)
}

// Subscribe starts a catch-up subscription to a conversation in scope.
func (s *Service) Subscribe(ctx context.Context, scopeID int64, conversationID string, afterSeq int64) (*Subscription, int64, error) {
	if _, err := s.scopedConversation(ctx, scopeID, conversationID); err != nil {
		return nil, 0, err
	}
	return s.hub.Subscribe(ctx, conversationID, afterSeq)
}

func (s *Service) replay(ctx context.Context, scopeID int64, requestID, fingerprint string) (SendResult, bool, error) {
	r, err := s.store.Receipt(ctx, scopeID, requestID)
	if errors.Is(err, store.ErrNotFound) {
		return SendResult{}, false, nil
	}
	if err != nil {
		return SendResult{}, true, err
	}
	if r.Fingerprint != fingerprint {
		return SendResult{}, true, ErrRequestConflict
	}
	return SendResult{TurnID: r.Result, Replayed: true}, true, nil
}

// scopedConversation loads a conversation and checks it belongs to the
// caller's scope; another scope's conversation is reported as missing.
func (s *Service) scopedConversation(ctx context.Context, scopeID int64, conversationID string) (sqlitedb.Conversation, error) {
	conv, err := s.store.Conversation(ctx, conversationID)
	if err == nil && conv.ScopeID != scopeID {
		return sqlitedb.Conversation{}, fmt.Errorf("%w: conversation %s", store.ErrNotFound, conversationID)
	}
	return conv, err
}

func (s *Service) runner(ctx context.Context, conv sqlitedb.Conversation) (*ClaudeRunner, error) {
	s.mu.Lock()
	r := s.runners[conv.ID]
	s.mu.Unlock()
	if r != nil {
		return r, nil
	}
	if conv.Provider != "claude" || s.opts.Claude == nil {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedProvider, conv.Provider)
	}
	session, start, err := s.opts.Claude(ctx, conv)
	if err != nil {
		return nil, err
	}
	if session.ProviderSessionID == "" {
		session.ProviderSessionID = conv.ProviderSessionID
	}
	r = NewClaudeRunner(ClaudeRunnerOptions{
		ConversationID: conv.ID, ScopeID: conv.ScopeID, Files: s.store, Start: start, Session: session,
		Batcher: s.batcher, Limiter: s.limiter, ContextMCPName: s.opts.ContextMCPName, Now: s.opts.Now,
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing := s.runners[conv.ID]; existing != nil {
		return existing, nil
	}
	s.runners[conv.ID] = r
	return r, nil
}

func sendFingerprint(cmd SendCommand) string {
	data, _ := json.Marshal(struct {
		ConversationID string           `json:"conversation_id"`
		Text           string           `json:"text"`
		Content        []map[string]any `json:"content"`
	}{cmd.ConversationID, cmd.Text, cmd.Content})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
