package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

// ErrTurnRunning rejects a send while the conversation already runs a turn.
var ErrTurnRunning = errors.New("local conversation: a turn is already running")

// ClaudeAdapter is the running adapter process the runner talks to,
// implemented by *claude.Process.
type ClaudeAdapter interface {
	Request(ctx context.Context, typ string, fields map[string]any) (json.RawMessage, error)
	Close(ctx context.Context) error
	Done() <-chan struct{}
	Err() error
}

// StartClaudeAdapter launches an adapter delivering output to handler.
type StartClaudeAdapter func(ctx context.Context, handler claude.Handler) (ClaudeAdapter, error)

// ClaudeSession is how the conversation's adapter is started: the fields of
// the adapter start request, without resume, which the runner adds.
type ClaudeSession struct {
	Fields            map[string]any
	ProviderSessionID string
}

// SendRequest is one user turn.
type SendRequest struct {
	TurnID    string
	RequestID string
	MessageID string
	Text      string
	// Content is the SDK user message content; text-only when empty.
	Content []map[string]any
}

const (
	interruptDeadline = 10 * time.Second
	previewRunes      = 200
)

// ClaudeRunner runs one Claude conversation: it starts the adapter on
// demand, records each turn through the batcher, normalizes adapter output
// into events, and completes the turn when Claude reports its result or the
// adapter goes away. Output handling never blocks the adapter reader.
type ClaudeRunner struct {
	conversationID string
	start          StartClaudeAdapter
	session        ClaudeSession
	batcher        *Batcher
	limiter        *Limiter
	now            func() time.Time

	mu          sync.Mutex
	adapter     ClaudeAdapter
	norm        *claude.Normalizer
	turn        *claudeTurn
	contextName string
}

type claudeTurn struct {
	id              string
	cancelRequested bool
	// storageFailed is set when the batcher rejected output; the rest of
	// the turn's output is dropped and the turn ends as failed.
	storageFailed bool
}

// ClaudeRunnerOptions configures a runner.
type ClaudeRunnerOptions struct {
	ConversationID string
	Start          StartClaudeAdapter
	Session        ClaudeSession
	Batcher        *Batcher
	Limiter        *Limiter
	ContextMCPName string
	Now            func() time.Time
}

// NewClaudeRunner returns a runner for one conversation.
func NewClaudeRunner(opts ClaudeRunnerOptions) *ClaudeRunner {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &ClaudeRunner{
		conversationID: opts.ConversationID, start: opts.Start, session: opts.Session,
		batcher: opts.Batcher, limiter: opts.Limiter, now: opts.Now, contextName: opts.ContextMCPName,
	}
}

// Send starts a turn. It returns once the turn start is recorded and the
// prompt was handed to the adapter; output and completion follow as events.
func (r *ClaudeRunner) Send(ctx context.Context, req SendRequest) error {
	r.mu.Lock()
	if r.turn != nil {
		r.mu.Unlock()
		return ErrTurnRunning
	}
	if err := r.limiter.TryAcquire(); err != nil {
		r.mu.Unlock()
		return err
	}
	turn := &claudeTurn{id: req.TurnID}
	r.turn = turn
	r.mu.Unlock()

	now := r.now()
	running := "running"
	preview := truncateRunes(req.Text, previewRunes)
	err := r.batcher.Append(store.Batch{
		ConversationID: r.conversationID,
		StartTurn:      &store.NewTurn{ID: req.TurnID, RequestID: req.RequestID, StartedAt: now},
		Events: []store.NewEvent{
			r.event(req.TurnID, "", "user.message", true, map[string]any{"message_id": req.MessageID, "request_id": req.RequestID, "content": req.Text}, now),
			r.event(req.TurnID, "", "turn.started", false, map[string]any{"request_id": req.RequestID, "input_message_id": req.MessageID}, now),
		},
		Messages: []store.NewMessage{{ID: req.MessageID, TurnID: req.TurnID, Role: "user", Content: req.Text, CreatedAt: now}},
		Summary:  &store.SummaryPatch{Status: &running, LastMessagePreview: &preview, UpdatedAt: now},
	}, true)
	if err != nil {
		r.mu.Lock()
		r.turn = nil
		r.mu.Unlock()
		r.limiter.Release()
		return err
	}

	adapter, err := r.ensureAdapter(ctx)
	if err != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_unavailable", message: err.Error()})
		return err
	}
	content := req.Content
	if len(content) == 0 {
		content = []map[string]any{{"type": "text", "text": req.Text}}
	}
	if _, err := adapter.Request(ctx, "send", map[string]any{"request_id": req.RequestID, "content": content}); err != nil {
		kind := "provider_error"
		var adapterErr *claude.AdapterError
		if errors.As(err, &adapterErr) && adapterErr.Dispatch == "outcome_unknown" {
			kind = "outcome_unknown"
		}
		r.finish(turn, "failed", &turnError{kind: kind, message: err.Error()})
		return err
	}
	return nil
}

// Interrupt asks Claude to stop the running turn. The turn completes as
// cancelled when the adapter confirms or the Query ends.
func (r *ClaudeRunner) Interrupt(ctx context.Context) error {
	r.mu.Lock()
	turn, adapter := r.turn, r.adapter
	if turn != nil {
		turn.cancelRequested = true
	}
	r.mu.Unlock()
	if turn == nil || adapter == nil {
		return nil
	}
	data, err := adapter.Request(ctx, "interrupt", map[string]any{"deadline_ms": interruptDeadline.Milliseconds()})
	if err != nil {
		return err
	}
	var result struct {
		Outcome string `json:"outcome"`
	}
	_ = json.Unmarshal(data, &result)
	if result.Outcome == "closed" {
		// The Query transport was closed; no result will follow.
		r.finish(turn, "cancelled", nil)
	}
	return nil
}

// Close stops the adapter, failing a running turn.
func (r *ClaudeRunner) Close(ctx context.Context) error {
	r.mu.Lock()
	adapter, turn := r.adapter, r.turn
	r.adapter = nil
	r.mu.Unlock()
	if turn != nil {
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: "the conversation was closed"})
	}
	if adapter == nil {
		return nil
	}
	return adapter.Close(ctx)
}

func (r *ClaudeRunner) ensureAdapter(ctx context.Context) (ClaudeAdapter, error) {
	r.mu.Lock()
	if r.adapter != nil {
		a := r.adapter
		r.mu.Unlock()
		return a, nil
	}
	r.mu.Unlock()

	norm := claude.NewNormalizer(r.contextName)
	adapter, err := r.start(ctx, func(out claude.Output) { r.handle(norm, out) })
	if err != nil {
		return nil, err
	}
	fields := map[string]any{}
	for k, v := range r.session.Fields {
		fields[k] = v
	}
	r.mu.Lock()
	if id := r.session.ProviderSessionID; id != "" {
		fields["resume"] = id
	}
	r.mu.Unlock()
	if _, err := adapter.Request(ctx, "start", fields); err != nil {
		_ = adapter.Close(ctx)
		return nil, err
	}
	r.mu.Lock()
	r.adapter, r.norm = adapter, norm
	r.mu.Unlock()
	go r.watch(adapter)
	return adapter, nil
}

// watch fails the running turn when the adapter process goes away.
func (r *ClaudeRunner) watch(adapter ClaudeAdapter) {
	<-adapter.Done()
	r.mu.Lock()
	if r.adapter != adapter {
		r.mu.Unlock()
		return
	}
	r.adapter = nil
	turn := r.turn
	r.mu.Unlock()
	if turn != nil {
		message := "Claude adapter exited"
		if err := adapter.Err(); err != nil {
			message = err.Error()
		}
		r.finish(turn, "failed", &turnError{kind: "provider_exited", message: message})
	}
}

// handle runs on the adapter's reader goroutine and must not block.
func (r *ClaudeRunner) handle(norm *claude.Normalizer, out claude.Output) {
	r.mu.Lock()
	turn := r.turn
	cancelRequested := turn != nil && turn.cancelRequested
	r.mu.Unlock()
	switch out.Type {
	case "sdk_message":
		events := norm.Accept(out.Message)
		if id := norm.SessionID(); id != "" {
			r.rememberSession(id)
		}
		if turn != nil {
			r.appendOutput(turn, events)
		}
		if result := norm.TakeResult(); result != nil && turn != nil {
			switch {
			case turn.storageFailed:
				r.finish(turn, "failed", &turnError{kind: "storage_limit", message: ErrStorageBacklog.Error()})
			case cancelRequested:
				r.finish(turn, "cancelled", nil)
			case result.IsError:
				r.finish(turn, "failed", &turnError{kind: "provider_error", message: result.Error})
			default:
				r.finish(turn, "completed", nil)
			}
		}
	case "error":
		if turn != nil {
			status := "failed"
			if cancelRequested {
				status = "cancelled"
			}
			r.finish(turn, status, &turnError{kind: "provider_exited", message: out.Error.Message})
		}
	}
}

func (r *ClaudeRunner) appendOutput(turn *claudeTurn, events []claude.Event) {
	if turn.storageFailed || len(events) == 0 {
		return
	}
	now := r.now()
	batch := store.Batch{ConversationID: r.conversationID}
	var preview *string
	for _, e := range events {
		if e.Image != nil {
			// Inline images need attachment storage, which the service does
			// not have yet; they are not recorded.
			continue
		}
		batch.Events = append(batch.Events, r.event(turn.id, e.ItemID, e.Type, e.Final, e.Payload, now))
		if e.Final && e.Payload["kind"] == "assistant_text" {
			text, _ := e.Payload["text"].(string)
			batch.Messages = append(batch.Messages, store.NewMessage{ID: e.ItemID, TurnID: turn.id, Role: "assistant", Content: text, CreatedAt: now})
			p := truncateRunes(text, previewRunes)
			preview = &p
		}
	}
	if preview != nil {
		batch.Summary = &store.SummaryPatch{LastMessagePreview: preview, UpdatedAt: now}
	}
	if err := r.batcher.Append(batch, false); err != nil {
		r.mu.Lock()
		turn.storageFailed = true
		adapter := r.adapter
		r.mu.Unlock()
		if adapter != nil {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), interruptDeadline)
				defer cancel()
				_, _ = adapter.Request(ctx, "interrupt", map[string]any{"deadline_ms": interruptDeadline.Milliseconds()})
			}()
		}
	}
}

type turnError struct {
	kind    string
	message string
}

// finish completes turn once: open items get final events, then
// turn.completed and the turn row are committed together.
func (r *ClaudeRunner) finish(turn *claudeTurn, status string, failure *turnError) {
	r.mu.Lock()
	if r.turn != turn {
		r.mu.Unlock()
		return
	}
	r.turn = nil
	norm := r.norm
	r.mu.Unlock()
	defer r.limiter.Release()

	now := r.now()
	itemStatus := status
	if itemStatus == "completed" {
		// A completed turn still closes items Claude never finished.
		itemStatus = "cancelled"
	}
	batch := store.Batch{ConversationID: r.conversationID}
	if norm != nil {
		for _, e := range norm.Close(itemStatus) {
			batch.Events = append(batch.Events, r.event(turn.id, e.ItemID, e.Type, e.Final, e.Payload, now))
		}
	}
	payload := map[string]any{"status": status}
	completion := &store.TurnCompletion{TurnID: turn.id, Status: status, CompletedAt: now}
	if failure != nil {
		payload["error"] = map[string]any{"kind": failure.kind, "message": failure.message}
		completion.ErrorKind, completion.Error = failure.kind, failure.message
	}
	batch.Events = append(batch.Events, r.event(turn.id, "", "turn.completed", true, payload, now))
	batch.CompleteTurn = completion
	conversationStatus := "idle"
	if status == "failed" {
		conversationStatus = "failed"
	}
	batch.Summary = &store.SummaryPatch{Status: &conversationStatus, UpdatedAt: now}
	// Critical: committed with the output before it, never rejected by the
	// pending budget.
	_ = r.batcher.Append(batch, true)
}

func (r *ClaudeRunner) rememberSession(id string) {
	r.mu.Lock()
	changed := r.session.ProviderSessionID != id
	r.session.ProviderSessionID = id
	r.mu.Unlock()
	if changed {
		now := r.now()
		_ = r.batcher.Append(store.Batch{ConversationID: r.conversationID, ProviderSessionID: &id, Events: []store.NewEvent{
			r.event("", "", "conversation.updated", false, map[string]any{"provider_session_id": id}, now),
		}}, true)
	}
}

func (r *ClaudeRunner) event(turnID, itemID, typ string, final bool, payload map[string]any, at time.Time) store.NewEvent {
	data, err := json.Marshal(payload)
	if err != nil {
		data = []byte(fmt.Sprintf(`{"error":{"kind":"encoding","message":%q}}`, err.Error()))
	}
	return store.NewEvent{TurnID: turnID, ItemID: itemID, Type: typ, Final: final, Payload: data, CreatedAt: at}
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}
