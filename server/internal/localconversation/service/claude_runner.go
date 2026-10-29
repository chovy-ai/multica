package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/localconversation/provider/claude"
	"github.com/multica-ai/multica/server/internal/localconversation/store"
)

var (
	// ErrTurnRunning rejects a send while the conversation already runs a turn.
	ErrTurnRunning = errors.New("local conversation: a turn is already running")
	// ErrOutcomeUnknown means the prompt may or may not have reached Claude;
	// the command must not be replayed automatically (plan §8.1).
	ErrOutcomeUnknown = errors.New("local conversation: provider outcome unknown")
)

// ClaudeAdapter is the running adapter process the runner talks to,
// implemented by *claude.Process.
type ClaudeAdapter interface {
	Request(ctx context.Context, typ string, fields map[string]any) (json.RawMessage, error)
	Close(ctx context.Context) error
	Done() <-chan struct{}
	Err() error
}

// AttachmentFiles writes attachment files, implemented by *store.Store.
type AttachmentFiles interface {
	WriteAttachmentFile(scopeID int64, conversationID, mediaType string, data []byte, now time.Time) (store.NewAttachment, error)
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
	// Fingerprint identifies the request content for idempotent retries.
	Fingerprint string
	MessageID   string
	Text        string
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
	rec            turnRecorder
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
	ScopeID        int64
	Files          AttachmentFiles
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
		rec:            turnRecorder{conversationID: opts.ConversationID, scopeID: opts.ScopeID, files: opts.Files, now: opts.Now},
		conversationID: opts.ConversationID, start: opts.Start, session: opts.Session,
		batcher: opts.Batcher, limiter: opts.Limiter, now: opts.Now, contextName: opts.ContextMCPName,
	}
}

// Send starts a turn. It returns once the user input, turn start and command
// receipt are durable and the prompt was handed to the adapter; output and
// completion follow as events.
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

	_, err := r.batcher.AppendWait(ctx, r.rec.startBatch(req))
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
		var adapterErr *claude.AdapterError
		if errors.As(err, &adapterErr) && (adapterErr.Dispatch == "not_dispatched" || adapterErr.Dispatch == "rejected") {
			r.finish(turn, "failed", &turnError{kind: "provider_error", message: err.Error()})
			return err
		}
		// Anything else may have reached Claude: transport errors included.
		r.finish(turn, "failed", &turnError{kind: "outcome_unknown", message: err.Error()})
		return fmt.Errorf("%w: %w", ErrOutcomeUnknown, err)
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
	out := make([]outputEvent, len(events))
	for i, e := range events {
		out[i] = claudeOutput(e)
	}
	batch := r.rec.outputBatch(turn.id, out)
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

	itemStatus := status
	if itemStatus == "completed" {
		// A completed turn still closes items Claude never finished.
		itemStatus = "cancelled"
	}
	var finals []outputEvent
	if norm != nil {
		for _, e := range norm.Close(itemStatus) {
			finals = append(finals, claudeOutput(e))
		}
	}
	// Critical: committed with the output before it, never rejected by the
	// pending budget.
	_ = r.batcher.Append(r.rec.completionBatch(turn.id, status, failure, finals), true)
}

func (r *ClaudeRunner) rememberSession(id string) {
	r.mu.Lock()
	changed := r.session.ProviderSessionID != id
	r.session.ProviderSessionID = id
	r.mu.Unlock()
	if changed {
		_ = r.batcher.Append(r.rec.sessionBatch(id), true)
	}
}

// ApplySettings changes the provider settings. A live adapter is updated in
// place; later adapter starts use the new values.
func (r *ClaudeRunner) ApplySettings(ctx context.Context, st store.ConversationSettings) error {
	r.mu.Lock()
	fields := map[string]any{}
	for k, v := range r.session.Fields {
		fields[k] = v
	}
	delete(fields, "model")
	delete(fields, "reasoning_effort")
	if st.Model != nil {
		fields["model"] = *st.Model
	}
	if st.ReasoningEffort != nil {
		fields["reasoning_effort"] = *st.ReasoningEffort
	}
	fields["permission_mode"] = st.PermissionMode
	r.session.Fields = fields
	adapter := r.adapter
	r.mu.Unlock()
	if adapter == nil {
		return nil
	}
	var model any
	if st.Model != nil {
		model = *st.Model
	}
	if _, err := adapter.Request(ctx, "set_model", map[string]any{"model": model}); err != nil {
		return err
	}
	var effort any
	if st.ReasoningEffort != nil {
		effort = *st.ReasoningEffort
	}
	if _, err := adapter.Request(ctx, "apply_flag_settings", map[string]any{"settings": map[string]any{"effortLevel": effort}}); err != nil {
		return err
	}
	_, err := adapter.Request(ctx, "set_permission_mode", map[string]any{"mode": st.PermissionMode})
	return err
}

func claudeOutput(e claude.Event) outputEvent {
	out := outputEvent{ItemID: e.ItemID, Type: e.Type, Final: e.Final, Payload: e.Payload}
	if e.Image != nil {
		out.ImageMime, out.ImageData = e.Image.MimeType, e.Image.Data
	}
	return out
}
